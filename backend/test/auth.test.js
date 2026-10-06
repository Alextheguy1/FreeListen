// Integration tests for the sign-in gate. These run the real server in a child
// process against a throwaway config directory, because the behaviour that
// matters is what the HTTP layer refuses, not what a function returns.
//
// The case worth protecting: before an account exists, every route except the
// healthcheck and setup must refuse. Without that, the window between first
// start and finishing setup is wide open.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const SERVER = path.join(__dirname, "..", "server.js");
const PORT = 5100 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let configDir;

function start() {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "fl-auth-config-"));
  const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "fl-auth-music-"));
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: configDir, MUSIC_DIR: musicDir },
    stdio: "ignore",
  });
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("server did not come up");
}

test.before(async () => { start(); await waitForServer(); });
test.after(() => { if (child) child.kill(); });

const json = async (p, opts) => {
  const r = await fetch(BASE + p, opts);
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
};
const post = (p, body, cookie) => json(p, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
});

let session = null;

test("before an account exists", async t => {
  await t.test("the healthcheck still answers, so the container stays healthy", async () => {
    const r = await json("/api/health");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(r.body.version, "reports its version");
  });

  await t.test("every other route refuses", async () => {
    for (const p of ["/api/settings", "/api/library", "/api/activity", "/api/playlist?url=x"]) {
      const r = await json(p);
      assert.equal(r.status, 403, `${p} should refuse before setup`);
      assert.equal(r.body.setupRequired, true, p);
    }
  });

  await t.test("downloads and deletes refuse too", async () => {
    assert.equal((await post("/api/download", { query: "x", title: "t", artist: "a" })).status, 403);
    assert.equal((await json("/api/library/a.mp3", { method: "DELETE" })).status, 403);
  });

  await t.test("status reports it is unconfigured", async () => {
    const r = await json("/api/auth/status");
    assert.equal(r.body.configured, false);
    assert.equal(r.body.authenticated, false);
  });
});

test("creating the account", async t => {
  await t.test("rejects a short username", async () => {
    assert.equal((await post("/api/auth/setup", { username: "ab", password: "longenough1" })).status, 400);
  });

  await t.test("rejects a short password", async () => {
    assert.equal((await post("/api/auth/setup", { username: "alex", password: "short" })).status, 400);
  });

  await t.test("succeeds and issues an HttpOnly session cookie", async () => {
    const r = await post("/api/auth/setup", { username: "alex", password: "correct-horse-9" });
    assert.equal(r.status, 200);
    const setCookie = r.headers.get("set-cookie") || "";
    assert.match(setCookie, /fl_session=/);
    assert.match(setCookie, /HttpOnly/, "page scripts must not be able to read it");
    assert.match(setCookie, /SameSite=Strict/, "another site must not be able to send it");
    session = setCookie.split(";")[0];
  });

  await t.test("cannot be run twice, so the account cannot be taken over", async () => {
    const r = await post("/api/auth/setup", { username: "mallory", password: "hunter22222" });
    assert.equal(r.status, 409);
  });
});

test("once an account exists", async t => {
  await t.test("routes answer 401 without a session, not 403", async () => {
    const r = await json("/api/settings");
    assert.equal(r.status, 401);
  });

  await t.test("routes answer with a valid session", async () => {
    const r = await json("/api/settings", { headers: { Cookie: session } });
    assert.equal(r.status, 200);
  });

  await t.test("a wrong password and a wrong username fail the same way", async () => {
    const bad = await post("/api/auth/login", { username: "alex", password: "nope12345" });
    const noUser = await post("/api/auth/login", { username: "mallory", password: "correct-horse-9" });
    assert.equal(bad.status, 401);
    assert.equal(noUser.status, 401);
    assert.equal(bad.body.error, noUser.body.error, "must not reveal which was wrong");
  });

  await t.test("the right credentials sign in", async () => {
    assert.equal((await post("/api/auth/login", { username: "alex", password: "correct-horse-9" })).status, 200);
  });
});

test("saved credentials are write-only", async t => {
  await t.test("a stored secret is never returned", async () => {
    await post("/api/settings", { listenbrainzToken: "lb-SECRET-TOKEN" }, session);
    const r = await fetch(`${BASE}/api/settings`, { headers: { Cookie: session } });
    const text = await r.text();
    assert.ok(!text.includes("SECRET"), "the value must not come back");
    assert.equal(JSON.parse(text).listenbrainzTokenSet, true, "but it reports that one is set");
  });

  await t.test("it is stored, not discarded", () => {
    const saved = JSON.parse(fs.readFileSync(path.join(configDir, "settings.json"), "utf8"));
    assert.equal(saved.listenbrainzToken, "lb-SECRET-TOKEN");
  });

  await t.test("the password is never stored in the clear", () => {
    const raw = fs.readFileSync(path.join(configDir, "settings.json"), "utf8");
    assert.ok(!raw.includes("correct-horse-9"));
    assert.ok(JSON.parse(raw).authHash, "a hash is stored instead");
  });
});

test("a bad path template is refused rather than silently replaced", async () => {
  const before = (await json("/api/settings", { headers: { Cookie: session } })).body.albumTemplate;
  const r = await post("/api/settings", { albumTemplate: "../{title}" }, session);
  assert.equal(r.status, 400);
  const after = (await json("/api/settings", { headers: { Cookie: session } })).body.albumTemplate;
  assert.equal(after, before, "the previous template must survive a rejected save");
});

test("signing out invalidates the session", async () => {
  const r = await post("/api/auth/logout", {}, session);
  assert.equal(r.status, 200);
  assert.equal((await json("/api/settings", { headers: { Cookie: session } })).status, 401);
});
