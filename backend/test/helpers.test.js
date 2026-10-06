// Unit tests for the pure helpers. Every case here is one that actually bit:
// the SSRF allowlist, the ".." traversal, the dangling separator in templates,
// and the DRM error that was being retried pointlessly.
//
//   npm test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

// Point the save directory somewhere disposable before requiring the server,
// since it creates the directory at load time.
const SAVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fl-test-music-"));
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fl-test-config-"));
process.env.MUSIC_DIR = SAVE_DIR;
process.env.CONFIG_DIR = CONFIG_DIR;

const srv = require("../server.js");

test("cover art allowlist", async t => {
  await t.test("permits the hosts the app actually sources art from", () => {
    for (const url of [
      "https://coverartarchive.org/release/abc/front-250",
      "https://ia801504.us.archive.org/x/front.jpg",
      "https://i.scdn.co/image/ab67616d0000",
    ]) {
      assert.equal(srv.allowedCoverArtUrl(url), true, url);
    }
  });

  await t.test("refuses internal and arbitrary targets", () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "https://169.254.169.254/latest/meta-data/",
      "http://192.168.1.1/admin",
      "http://127.0.0.1:5051/api/settings",
      "file:///etc/passwd",
      "https://evil.example/x.png",
    ]) {
      assert.equal(srv.allowedCoverArtUrl(url), false, url);
    }
  });

  await t.test("is not fooled by hosts that merely contain an allowed one", () => {
    assert.equal(srv.allowedCoverArtUrl("https://coverartarchive.org.evil.example/x.png"), false);
    assert.equal(srv.allowedCoverArtUrl("https://evilcoverartarchive.org/x.png"), false);
  });

  await t.test("requires https", () => {
    assert.equal(srv.allowedCoverArtUrl("http://coverartarchive.org/release/a/front"), false);
  });

  await t.test("handles rubbish input", () => {
    for (const v of [null, undefined, "", "   ", 42, {}, "not a url"]) {
      assert.equal(srv.allowedCoverArtUrl(v), false, String(v));
    }
  });
});

test("filename sanitising", async t => {
  await t.test("strips separators and characters Windows rejects", () => {
    assert.equal(srv.sanitizeForFilename("AC/DC"), "ACDC");
    assert.equal(srv.sanitizeForFilename('a<b>c:d"e|f?g*h'), "abcdefgh");
    assert.equal(srv.sanitizeForFilename("back\\slash"), "backslash");
  });

  await t.test("empties names that are only dots, which would walk the path up", () => {
    for (const v of ["..", ".", "...", " .. "]) {
      assert.equal(srv.sanitizeForFilename(v), "", JSON.stringify(v));
    }
  });

  await t.test("leaves ordinary names alone", () => {
    assert.equal(srv.sanitizeForFilename("Michael Jackson"), "Michael Jackson");
    assert.equal(srv.sanitizeForFilename("Sigur Rós"), "Sigur Rós");
  });

  await t.test("collapses runs of whitespace", () => {
    assert.equal(srv.sanitizeForFilename("  a   b  "), "a b");
  });
});

test("template validation", async t => {
  await t.test("accepts usable templates", () => {
    for (const v of [
      "{artist}/{album}/{track} - {title}",
      "{artist}/{title}",
      "{title}",
      "{genre}/{artist} - {album}/{track}. {title}",
    ]) {
      assert.equal(srv.validTemplate(v), true, v);
    }
  });

  await t.test("refuses anything that could escape the library", () => {
    for (const v of ["../{title}", "/{artist}/{title}", "C:/music/{title}", "{artist}\\{title}"]) {
      assert.equal(srv.validTemplate(v), false, v);
    }
  });

  await t.test("refuses a template with no per-track part", () => {
    assert.equal(srv.validTemplate("{artist}/{album}"), false);
  });

  await t.test("refuses unknown tokens and empty input", () => {
    assert.equal(srv.validTemplate("{artist}/{nope}"), false);
    assert.equal(srv.validTemplate(""), false);
    assert.equal(srv.validTemplate(null), false);
  });
});

test("destination rendering", async t => {
  const rel = (tags, n) => {
    const { dir, baseName } = srv.renderDestination(tags, n);
    return path.relative(path.resolve(SAVE_DIR), path.resolve(path.join(dir, baseName)))
      .split(path.sep).join("/");
  };
  const MJ = { artist: "Michael Jackson", album: "Thriller", title: "Billie Jean", year: "1982", genre: "Pop" };

  await t.test("defaults reproduce the documented layout", () => {
    srv._setSettingsForTest({
      albumTemplate: "{artist}/{album}/{track} - {title}",
      singleTemplate: "{artist}/{title}",
    });
    assert.equal(rel(MJ, 7), "Michael Jackson/Thriller/07 - Billie Jean");
    assert.equal(rel({ artist: "Michael Jackson", title: "Billie Jean" }, null), "Michael Jackson/Billie Jean");
  });

  await t.test("a missing token takes its dangling separator with it", () => {
    assert.equal(rel(MJ, null), "Michael Jackson/Thriller/Billie Jean");
  });

  await t.test("an empty segment is dropped rather than left unnamed", () => {
    srv._setSettingsForTest({ albumTemplate: "{artist}/{year}/{title}" });
    assert.equal(rel({ artist: "A", album: "B", title: "C" }, 1), "A/C");
  });

  await t.test("custom templates render", () => {
    srv._setSettingsForTest({ albumTemplate: "{artist}/{year} - {album}/{track}. {title}" });
    assert.equal(rel(MJ, 3), "Michael Jackson/1982 - Thriller/03. Billie Jean");
  });

  await t.test("tag values cannot escape the library", () => {
    srv._setSettingsForTest({
      albumTemplate: "{artist}/{album}/{track} - {title}",
      singleTemplate: "{artist}/{title}",
    });
    const root = path.resolve(SAVE_DIR);
    for (const bad of ["..", "../..", "."]) {
      const { dir, baseName } = srv.renderDestination({ artist: bad, album: bad, title: bad }, null);
      const full = path.resolve(path.join(dir, baseName));
      assert.ok(full.startsWith(root + path.sep), `${bad} escaped to ${full}`);
    }
  });
});

test("download concurrency is clamped", () => {
  assert.equal(srv.clampConcurrency(1), 1);
  assert.equal(srv.clampConcurrency(3), 3);
  assert.equal(srv.clampConcurrency(99), 5, "above the ceiling");
  assert.equal(srv.clampConcurrency(0), 1, "below the floor");
  assert.equal(srv.clampConcurrency(-4), 1);
  assert.equal(srv.clampConcurrency("2"), 2, "numeric strings from JSON");
  assert.equal(srv.clampConcurrency("nonsense"), 1);
  assert.equal(srv.clampConcurrency(undefined), 1);
  assert.equal(srv.clampConcurrency(2.5), 1, "non-integers fall back");
});

test("download failures", async t => {
  // execa puts the exit code in message and the real reason in stderr.
  const drm = { shortMessage: "Command failed with exit code 1", stderr:
    "WARNING: [soundcloud] 291313240: hls_mp3 format not found\nERROR: [soundcloud] 718846078: This video is DRM protected" };

  await t.test("pulls the real reason out of stderr", () => {
    assert.equal(srv.downloadErrorText(drm), "This video is DRM protected");
  });

  await t.test("falls back to the message when stderr says nothing useful", () => {
    assert.equal(srv.downloadErrorText({ shortMessage: "spawn ENOENT", stderr: "" }), "spawn ENOENT");
  });

  await t.test("treats DRM and removals as permanent, so they skip the retry", () => {
    assert.equal(srv.isPermanentFailure(drm), true);
    assert.equal(srv.isPermanentFailure({ stderr: "ERROR: Private video" }), true);
    assert.equal(srv.isPermanentFailure({ stderr: "ERROR: Video unavailable" }), true);
  });

  await t.test("treats a transient network error as worth retrying", () => {
    assert.equal(srv.isPermanentFailure({ stderr: "ERROR: unable to download: HTTP 503" }), false);
    assert.equal(srv.isPermanentFailure({ shortMessage: "socket hang up", stderr: "" }), false);
  });
});

test("password hashing", async t => {
  await t.test("is salted, so the same password hashes differently", () => {
    assert.notEqual(srv.hashPassword("correct horse", "salt-a"), srv.hashPassword("correct horse", "salt-b"));
  });

  await t.test("is deterministic for a given salt", () => {
    assert.equal(srv.hashPassword("correct horse", "salt-a"), srv.hashPassword("correct horse", "salt-a"));
  });

  await t.test("does not contain the password", () => {
    assert.ok(!srv.hashPassword("correct horse", "salt-a").includes("correct"));
  });
});
