const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---- SEO: адрес сайта подставляется в страницу, плюс robots.txt и sitemap.xml ----
app.set("trust proxy", true);
const baseUrl = req => (process.env.SITE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

// Страница читается при каждом запросе: правки index.html видны сразу, без кэша
const readIndex = () => { try { return fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8"); } catch { return ""; } };

app.get(["/", "/index.html"], (req, res, next) => {
    const indexHtml = readIndex();
    if (!indexHtml) return next();
    const verify = String(process.env.GOOGLE_VERIFY || "").replace(/[^\w-]/g, "");
    let html = indexHtml.split("__SITE_URL__").join(baseUrl(req));
    const bing = String(process.env.BING_VERIFY || "").replace(/[^\w-]/g, "");
    html = verify
        ? html.split("__GOOGLE_VERIFY__").join(verify)
        : html.replace(/\s*<meta name="google-site-verification"[^>]*>/, "");
    html = bing
        ? html.split("__BING_VERIFY__").join(bing)
        : html.replace(/\s*<meta name="msvalidate.01"[^>]*>/, "");
    res.set("Cache-Control", "no-store").type("html").send(html);
});

app.get("/robots.txt", (req, res) => {
    res.type("text/plain").send(`User-agent: *\nAllow: /\n\nSitemap: ${baseUrl(req)}/sitemap.xml\n`);
});

app.get("/sitemap.xml", (req, res) => {
    res.type("application/xml").send(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
        `<url><loc>${baseUrl(req)}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url></urlset>\n`
    );
});

app.use(express.static("public"));

const rooms = new Map();
const reply = (cb, obj) => { if (typeof cb === "function") cb(obj); };

const FACES = ["🙂","😎","😄","😁","😂","😐","😶","🤔","😴","😮","😡","🥳","🤓","😇","🤠","😈","👽","🤖","🐻","🐺"];
const BODIES = ["triangle","circle","square","rectangle","diamond","star","oval","hexagon","capsule","shield"];
const COLORS = ["#d65b4a","#e58a42","#e5c34d","#83b85b","#3caa82","#45a6b8","#4c79c9","#8062c7",
                "#bb65ae","#e58eae","#eeeeee","#777777","#49352e","#222222","#a66d42","#c7a78c"];

const NIGHT_SECONDS = 25;
const SPECIAL = ["mafia", "doctor", "sheriff"];
const ROLE_RU = { mafia: "Мафия", sheriff: "Шериф", doctor: "Доктор", citizen: "Мирный житель" };


function cleanName(value) {
    if (typeof value === "string" || typeof value === "number") {
        return String(value).trim().slice(0, 20);
    }
    if (value && typeof value === "object") {
        return cleanName(value.name ?? value.displayName ?? value.username ?? value.value ?? "");
    }
    return "";
}

function cleanCharacter(value) {
    if (!value || typeof value !== "object") value = {};
    return {
        face: FACES.includes(value.face) ? value.face : "🙂",
        shape: BODIES.includes(value.shape) ? value.shape : "capsule",
        color: COLORS.includes(value.color) ? value.color : COLORS[0]
    };
}

function generateCode() {
    let code;
    do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(code));
    return code;
}

function validateSettings(settings) {
    if (!settings || typeof settings !== "object") settings = {};

    const mode = settings.mode === "auto" ? "auto" : "manual";
    const discussionTime = Math.round(Number(settings.discussionTime));
    const votingTime = Math.round(Number(settings.votingTime));
    const mafia = Math.round(Number(settings.roles?.mafia));
    const sheriff = Math.round(Number(settings.roles?.sheriff));
    const doctor = Math.round(Number(settings.roles?.doctor));
    const maxPlayers = Math.round(Number(settings.maxPlayers ?? 30));

    if (!Number.isFinite(discussionTime) || discussionTime < 15 || discussionTime > 300)
        return { error: "e_settings" };
    if (!Number.isFinite(votingTime) || votingTime < 20 || votingTime > 1800)
        return { error: "e_settings" };

    for (const count of [mafia, sheriff, doctor]) {
        if (!Number.isInteger(count) || count < 1 || count > 3)
            return { error: "e_settings" };
    }

    if (!Number.isInteger(maxPlayers) || maxPlayers < 4 || maxPlayers > 100)
        return { error: "e_settings" };

    // ведущий не играет: нужно место для него и хотя бы одного мирного жителя
    if (mafia + sheriff + doctor + 2 > maxPlayers)
        return { error: "maxRolesError" };

    return { settings: { mode, discussionTime, votingTime, maxPlayers, roles: { mafia, sheriff, doctor } } };
}

/* ---------- вспомогательные ---------- */

function findRoom(socketId) {
    for (const [code, room] of rooms) {
        if (room.players.some(p => p.id === socketId)) return { code, room };
    }
    return null;
}

const nameOf = (room, id) => room.players.find(p => p.id === id)?.name || "Игрок";

function publicRoom(room, code) {
    const g = room.game;
    return {
        code,
        hostId: room.hostId,
        serverNow: Date.now(),
        players: room.players.map(p => ({ id: p.id, name: p.name, character: { ...p.character }, cos: p.cos || {} })),
        settings: { ...room.settings, roles: { ...room.settings.roles } },
        game: g ? {
            phase: g.phase,
            round: g.round,
            endsAt: g.endsAt,
            alive: [...g.alive],
            voted: Object.keys(g.votes),
            deadRoles: { ...g.deadRoles },
            winner: g.winner,
            reveal: g.reveal || null,
            exile: g.exile || null,
            roles: g.phase === "finished" ? { ...g.roles } : null
        } : {
            phase: "lobby", round: 0, endsAt: null, alive: [], voted: [],
            deadRoles: {}, winner: null, roles: null
        }
    };
}

// Личные данные: ведущий НЕ видит ролей. Мафия видит только своих.
function sendStates(code) {
    const room = rooms.get(code);
    if (!room) return;
    const g = room.game;

    for (const p of room.players) {
        const role = g && p.id !== room.hostId ? g.roles[p.id] || null : null;
        const mates = role === "mafia" ? Object.keys(g.roles).filter(id => g.roles[id] === "mafia") : [];
        const acted = g && g.phase === "night" && role ? g.night[role]?.[p.id] ?? null : null;

        io.to(p.id).emit("gameState", {
            role,
            mates,
            vote: g?.votes[p.id] || null,
            acted,
            checks: g?.checks[p.id] || []
        });
    }
}

function sendRoom(code) {
    const room = rooms.get(code);
    if (!room) return;
    io.to(code).emit("roomUpdate", publicRoom(room, code));
    sendStates(code);
}

const announce = (code, key, kind, params) => io.to(code).emit("announce", { key, kind, params });

function clearTimer(g) {
    if (g && g.timer) { clearTimeout(g.timer); g.timer = null; }
}

function winner(room) {
    const g = room.game;
    const mafia = g.alive.filter(id => g.roles[id] === "mafia").length;
    const others = g.alive.length - mafia;
    if (mafia === 0) return "town";
    if (others === 0) return "mafia";
    return null;
}

function kill(room, id) {
    const g = room.game;
    g.deadRoles[id] = g.roles[id];
    g.alive = g.alive.filter(x => x !== id);
}

function finish(code, win) {
    const room = rooms.get(code);
    const g = room?.game;
    if (!g || g.phase === "finished") return;
    clearTimer(g);
    g.phase = "finished";
    g.winner = win;
    g.endsAt = null;

    sendRoom(code);
}

/* ---------- фазы ---------- */

function enterPhase(code, phase) {
    const room = rooms.get(code);
    const g = room?.game;
    if (!g || g.phase === "finished") return;

    clearTimer(g);
    g.phase = phase;
    g.endsAt = null;

    if (phase === "night") {
        g.round++;
        g.reveal = null;
        g.exile = null;
        g.night = { mafia: {}, doctor: {}, sheriff: {} };
    }
    if (phase === "voting") { g.votes = {}; g.reveal = null; }

    if (room.settings.mode === "auto") {
        const secs = phase === "night" ? NIGHT_SECONDS
                   : phase === "morning" || phase === "exile" || phase === "exileRole" ? 4
                   : phase === "discussion" ? room.settings.discussionTime
                   : room.settings.votingTime;
        g.endsAt = Date.now() + secs * 1000;
        g.timer = setTimeout(() => {
            if (phase === "night") resolveNight(code);
            else if (phase === "morning") revealMorning(code);
            else if (phase === "exile") { if (g.exile && !g.exile.none) revealExileRole(code); else afterExile(code); }
            else if (phase === "exileRole") afterExile(code);
            else if (phase === "discussion") enterPhase(code, "voting");
            else resolveVoting(code);
        }, secs * 1000);
    }

    sendRoom(code);
}

function resolveNight(code) {
    const room = rooms.get(code);
    const g = room?.game;
    if (!g || g.phase !== "night") return;
    clearTimer(g);

    const tally = {};
    Object.values(g.night.mafia).forEach(t => { tally[t] = (tally[t] || 0) + 1; });
    const top = Math.max(0, ...Object.values(tally));
    const leaders = Object.keys(tally).filter(t => tally[t] === top);
    const victim = leaders.length ? leaders[Math.floor(Math.random() * leaders.length)] : null;
    const saved = Object.values(g.night.doctor);

    for (const [sheriffId, targetId] of Object.entries(g.night.sheriff)) {
        (g.checks[sheriffId] = g.checks[sheriffId] || []).push({
            id: targetId,
            name: nameOf(room, targetId),
            isMafia: g.roles[targetId] === "mafia"
        });
    }

    // Итог ночи пока скрыт: его покажут в центре стола после «Далее»
    const wasSaved = !!victim && saved.includes(victim);
    g.pending = { victim: victim && !wasSaved ? victim : null, saved: wasSaved };
    g.reveal = null;
    enterPhase(code, "morning");
}

function revealMorning(code) {
    const room = rooms.get(code);
    const g = room?.game;
    if (!g || g.phase !== "morning") return;
    clearTimer(g);

    const pend = g.pending || {};
    const v = pend.victim;

    if (v && g.alive.includes(v)) {
        const pl = room.players.find(x => x.id === v);
        g.reveal = { id: v, name: pl ? pl.name : "", character: cleanCharacter(pl?.character), cos: pl?.cos || {} };
        kill(room, v);
    } else {
        g.reveal = { none: true, saved: !!pend.saved };
    }
    g.pending = null;

    const win = winner(room);
    if (win) finish(code, win);
    else enterPhase(code, "discussion");
}

function resolveVoting(code) {
    const room = rooms.get(code);
    const g = room?.game;
    if (!g || g.phase !== "voting") return;
    clearTimer(g);

    const tally = {};
    for (const [voter, target] of Object.entries(g.votes)) {
        if (g.alive.includes(voter) && g.alive.includes(target)) tally[target] = (tally[target] || 0) + 1;
    }
    const top = Math.max(0, ...Object.values(tally));
    const leaders = Object.keys(tally).filter(t => tally[t] === top);

    g.votes = {};

    // Шаг 1: показываем в центре, кого изгнали (роль пока скрыта)
    if (leaders.length === 1 && top > 0) {
        const id = leaders[0];
        const pl = room.players.find(x => x.id === id);
        g.exile = { id, name: pl ? pl.name : "", character: cleanCharacter(pl?.character), cos: pl?.cos || {} };
    } else {
        g.exile = { none: true };
    }
    enterPhase(code, "exile");
}

// Шаг 2: раскрываем роль изгнанного
function revealExileRole(code) {
    const room = rooms.get(code);
    const g = room?.game;
    if (!g || g.phase !== "exile" || !g.exile || g.exile.none) return;
    clearTimer(g);

    g.exile.role = g.roles[g.exile.id];
    if (g.alive.includes(g.exile.id)) kill(room, g.exile.id);
    enterPhase(code, "exileRole");
}

// Шаг 3: проверяем победу — либо конец игры, либо новая ночь
function afterExile(code) {
    const room = rooms.get(code);
    const g = room?.game;
    if (!g || (g.phase !== "exile" && g.phase !== "exileRole")) return;
    clearTimer(g);

    const win = winner(room);
    if (win) finish(code, win);
    else {
        announce(code, "aNight", "night");
        enterPhase(code, "night");
    }
}

// В автоматическом режиме переходим раньше, если все уже сходили
function maybeAdvance(code) {
    const room = rooms.get(code);
    const g = room?.game;
    if (!g || room.settings.mode !== "auto") return;

    if (g.phase === "night") {
        const actors = g.alive.filter(id => SPECIAL.includes(g.roles[id]));
        if (actors.length && actors.every(id => g.night[g.roles[id]][id])) resolveNight(code);
    } else if (g.phase === "voting") {
        if (g.alive.length && g.alive.every(id => g.votes[id])) resolveVoting(code);
    }
}

function startGame(code) {
    const room = rooms.get(code);
    if (!room) return { error: "e_notfound" };
    if (room.game && room.game.phase !== "finished") return { error: "e_started" };

    const players = room.players.filter(p => p.id !== room.hostId);
    const r = room.settings.roles;
    const need = r.mafia + r.sheriff + r.doctor + 1;

    if (players.length < need)
        return { error: "e_needplayers", params: { n: need, c: players.length } };

    const list = [];
    for (let i = 0; i < r.mafia; i++) list.push("mafia");
    for (let i = 0; i < r.sheriff; i++) list.push("sheriff");
    for (let i = 0; i < r.doctor; i++) list.push("doctor");
    while (list.length < players.length) list.push("citizen");

    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }

    const roles = {};
    players.forEach((p, i) => { roles[p.id] = list[i]; });

    room.game = {
        phase: "lobby", round: 0, endsAt: null, timer: null, winner: null,
        roles, alive: players.map(p => p.id), votes: {}, deadRoles: {}, checks: {},
        night: { mafia: {}, doctor: {}, sheriff: {} }
    };

    announce(code, "aStart", "night");
    enterPhase(code, "night");
    return { success: true };
}

function removePlayer(id) {
    const found = findRoom(id);
    if (!found) return;

    const { code, room } = found;
    const g = room.game;
    const name = nameOf(room, id);
    const wasHost = room.hostId === id;

    room.players = room.players.filter(p => p.id !== id);
    io.sockets.sockets.get(id)?.leave(code);

    if (!room.players.length) {
        clearTimer(g);
        rooms.delete(code);
        return;
    }

    if (wasHost) {
        room.hostId = room.players[0].id;
        if (g) {
            clearTimer(g);
            room.game = null;
            announce(code, "aHostLeft", "err");
        }
        sendRoom(code);
        return;
    }

    if (g && g.phase !== "finished" && g.alive.includes(id)) {
        g.deadRoles[id] = g.roles[id];
        g.alive = g.alive.filter(x => x !== id);
        delete g.votes[id];
        for (const v of Object.keys(g.votes)) if (g.votes[v] === id) delete g.votes[v];
        for (const r of SPECIAL) delete g.night[r]?.[id];

        announce(code, "aLeft", "err", { name });

        const win = winner(room);
        if (win) { finish(code, win); return; }
        sendRoom(code);
        maybeAdvance(code);
        return;
    }

    sendRoom(code);
}

/* ---------- сокеты ---------- */

io.on("connection", socket => {

    socket.on("createRoom", (data, cb) => {
        const name = cleanName(data?.name);
        if (!name) return reply(cb, { error: "enterName" });

        const checked = validateSettings(data?.settings);
        if (checked.error) return reply(cb, { error: checked.error });

        const code = generateCode();
        rooms.set(code, {
            hostId: socket.id,
            players: [{ id: socket.id, name, character: cleanCharacter(data?.character), cos: {} }],
            settings: checked.settings,
            game: null
        });

        socket.join(code);
        reply(cb, { success: true, code, settings: checked.settings });
        sendRoom(code);
    });

    socket.on("joinRoom", (data, cb) => {
        const name = cleanName(data?.name);
        const code = String(data?.code ?? "").trim();

        if (!name) return reply(cb, { error: "enterName" });
        if (!/^\d{6}$/.test(code)) return reply(cb, { error: "enterCode" });

        const room = rooms.get(code);
        if (!room) return reply(cb, { error: "e_notfound" });
        if (room.game && room.game.phase !== "finished") return reply(cb, { error: "e_started" });
        if (room.players.length >= room.settings.maxPlayers) return reply(cb, { error: "roomFull" });
        if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase()))
            return reply(cb, { error: "e_dupname" });

        room.players.push({ id: socket.id, name, character: cleanCharacter(data?.character), cos: {} });
        socket.join(code);
        reply(cb, { success: true, code, settings: room.settings });
        sendRoom(code);
    });

    socket.on("getRoom", (data, cb) => {
        const found = findRoom(socket.id);
        if (!found) return reply(cb, { error: "e_notfound" });
        const result = publicRoom(found.room, found.code);
        reply(cb, { success: true, room: result });
        socket.emit("roomUpdate", result);
        sendStates(found.code);
    });

    socket.on("updateCharacter", (data, cb) => {
        const found = findRoom(socket.id);
        if (!found) return reply(cb, { error: "e_notfound" });
        found.room.players.find(p => p.id === socket.id).character = cleanCharacter(data?.character);
        reply(cb, { success: true });
        sendRoom(found.code);
    });

    socket.on("startGame", (data, cb) => {
        const found = findRoom(socket.id);
        if (!found) return reply(cb, { error: "e_notfound" });
        if (found.room.hostId !== socket.id) return reply(cb, { error: "e_hostonly" });
        reply(cb, startGame(found.code));
    });

    socket.on("nextPhase", (data, cb) => {
        const found = findRoom(socket.id);
        if (!found) return reply(cb, { error: "e_notfound" });

        const { code, room } = found;
        const g = room.game;

        if (room.hostId !== socket.id) return reply(cb, { error: "e_hostonly" });
        if (!g || g.phase === "finished") return reply(cb, { error: "e_phase" });
        if (room.settings.mode === "auto") return reply(cb, { error: "e_auto" });

        if (g.phase === "night") resolveNight(code);
        else if (g.phase === "morning") revealMorning(code);
        else if (g.phase === "discussion") enterPhase(code, "voting");
        else if (g.phase === "voting") resolveVoting(code);
        else if (g.phase === "exile") { if (g.exile && !g.exile.none) revealExileRole(code); else afterExile(code); }
        else if (g.phase === "exileRole") afterExile(code);

        reply(cb, { success: true });
    });

    socket.on("resetGame", (data, cb) => {
        const found = findRoom(socket.id);
        if (!found || found.room.hostId !== socket.id) return reply(cb, { error: "e_hostonly" });
        if (found.room.game?.phase !== "finished") return reply(cb, { error: "e_phase" });
        found.room.game = null;
        reply(cb, { success: true });
        sendRoom(found.code);
    });

    socket.on("castVote", (data, cb) => {
        const found = findRoom(socket.id);
        if (!found) return reply(cb, { error: "e_notfound" });

        const { code, room } = found;
        const g = room.game;
        const target = String(data?.targetId ?? "");

        if (!g || g.phase !== "voting") return reply(cb, { error: "e_phase" });
        if (!g.alive.includes(socket.id)) return reply(cb, { error: "e_dead" });
        if (!g.alive.includes(target)) return reply(cb, { error: "e_target" });
        if (target === socket.id) return reply(cb, { error: "e_target" });
        if (g.votes[socket.id]) return reply(cb, { error: "e_voted" });

        g.votes[socket.id] = target;
        reply(cb, { success: true });
        sendRoom(code);
        maybeAdvance(code);
    });

    socket.on("nightAction", (data, cb) => {
        const found = findRoom(socket.id);
        if (!found) return reply(cb, { error: "e_notfound" });

        const { code, room } = found;
        const g = room.game;
        const role = g?.roles[socket.id];
        const target = String(data?.targetId ?? "");

        if (!g || g.phase !== "night") return reply(cb, { error: "e_phase" });
        if (!SPECIAL.includes(role) || !g.alive.includes(socket.id)) return reply(cb, { error: "e_target" });
        if (!g.alive.includes(target)) return reply(cb, { error: "e_target" });
        if (role === "mafia" && g.roles[target] === "mafia") return reply(cb, { error: "e_target" });
        if (role === "sheriff" && target === socket.id) return reply(cb, { error: "e_target" });
        if (g.night[role][socket.id]) return reply(cb, { error: "e_voted" });

        g.night[role][socket.id] = target;
        reply(cb, { success: true });
        sendStates(code);
        maybeAdvance(code);
    });

    socket.on("chatMessage", (data, cb) => {
        const found = findRoom(socket.id);
        if (!found) return reply(cb, { error: "e_notfound" });

        const { code, room } = found;
        const g = room.game;
        const me = room.players.find(p => p.id === socket.id);
        const message = String(data?.message ?? "").trim().slice(0, 300);

        if (!message) return reply(cb, { error: "e_generic" });

        const payload = { name: me.name, message, playerId: socket.id, time: Date.now() };
        const active = g && g.phase !== "finished";

        if (active && socket.id !== room.hostId && !g.alive.includes(socket.id))
            return reply(cb, { error: "e_dead" });

        if (active && g.phase === "night") {
            if (g.roles[socket.id] !== "mafia") return reply(cb, { error: "e_nightchat" });
            for (const id of g.alive.filter(x => g.roles[x] === "mafia")) {
                io.to(id).emit("chatMessage", { ...payload, channel: "mafia" });
            }
            return reply(cb, { success: true });
        }

        io.to(code).emit("chatMessage", payload);
        reply(cb, { success: true });
    });

    socket.on("leaveRoom", (data, cb) => {
        removePlayer(socket.id);
        reply(cb, { success: true });
    });

    socket.on("disconnect", () => removePlayer(socket.id));
});

const PORT = process.env.PORT || 3000;

server.on("error", err => {
    if (err.code === "EADDRINUSE") {
        console.error(`\nПорт ${PORT} занят: на нём ещё работает СТАРЫЙ сервер.\nЗакройте его командой:  taskkill /F /IM node.exe   и запустите снова.\n`);
        process.exit(1);
    }
    throw err;
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Mafia Game запущена: http://localhost:${PORT}`);
});
