import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalBinding, validateLocalBinding, listAvailableThreads, readBoundThread, contextContentFingerprint } from "../scripts/local-context.mjs";
import { listLocalSessions, readLocalSession } from "../scripts/local-sessions.mjs";
import { requestCodexHistory, listCodexThreads, readCodexThread } from "../scripts/codex-app-server.mjs";

const ID = "11111111-2222-3333-4444-555555555555";
const OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const row = (type, payload) => `${JSON.stringify({ type, payload })}\n`;
const message = (role, text) => row("response_item", { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] });
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cpa-context-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const directory = path.join(home, "sessions", "2026", "10", "02");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-${ID}.jsonl`);
  await fs.writeFile(file, row("session_meta", { id: ID, cwd: home, source: "cli" }) + row("turn_context", { turn_id: "one" }) + message("developer", "PRIVATE_SYSTEM") + message("user", "Keep the 36px buttons") + message("assistant", "Proposal: add a purple glow"));
  await fs.writeFile(path.join(home, "session_index.jsonl"), JSON.stringify({ id: ID, thread_name: "Project A", updated_at: "2026-10-02" }) + "\n");
  return { home, file };
}
const failingRead = async () => { throw new Error("test_offline"); };

test("local list uses real metadata ID and titles without opening account/config files", async (t) => {
  const { home } = await fixture(t);
  await fs.writeFile(path.join(home, "auth.json"), "BROKEN_SECRET_FILE");
  const listed = await listAvailableThreads({ codexHome: home, listThreads: failingRead });
  assert.equal(listed.source, "codex-local-session");
  assert.equal(listed.threads.length, 1);
  assert.equal(listed.threads[0].id, ID);
  assert.equal(listed.threads[0].name, "Project A");
  assert.equal(JSON.stringify(listed).includes("BROKEN_SECRET_FILE"), false);
});

test("persistent identity includes home and real thread, rejects share ID and different machine", async (t) => {
  const { home } = await fixture(t);
  const bound = await createLocalBinding({ id: ID, name: "Project A", cwd: home }, home);
  assert.deepEqual(await validateLocalBinding(JSON.parse(JSON.stringify(bound))), bound);
  const another = await fs.mkdtemp(path.join(os.tmpdir(), "cpa-context-other-"));
  t.after(() => fs.rm(another, { recursive: true, force: true }));
  assert.notEqual(bound.targetKey, (await createLocalBinding({ id: ID }, another)).targetKey);
  await assert.rejects(createLocalBinding({ id: "cx_6aaacdc5804481918c22acc90639d481" }, home), /invalid_local_thread_id/);
  await assert.rejects(validateLocalBinding({ ...bound, hostName: "different-machine" }), /wrong_machine/);
  await assert.rejects(createLocalBinding({ id: "../../auth.json" }, home), /invalid_local_thread_id/);
});

test("fallback refresh rereads the same ID, reflects appended correction, labels partial and omits system", async (t) => {
  const { home, file } = await fixture(t);
  const bound = await createLocalBinding({ id: ID, name: "Project A" }, home);
  const first = await readBoundThread(bound, { readThread: failingRead });
  assert.equal(first.access, "read");
  assert.equal(first.coverage.kind, "partial");
  assert.equal(first.text.includes("PRIVATE_SYSTEM"), false);
  assert.match(first.text, /assistant: Proposal/);
  await fs.appendFile(file, message("user", "Correction: use white only; no purple glow"));
  const next = await readBoundThread(bound, { readThread: failingRead });
  assert.match(next.text, /Correction: use white only/);
  assert.notEqual(contextContentFingerprint(first), contextContentFingerprint(next));
  const same = await readBoundThread(bound, { readThread: failingRead });
  assert.equal(contextContentFingerprint(next), contextContentFingerprint(same));
});

test("deleted bound history fails instead of switching to another session", async (t) => {
  const { home, file } = await fixture(t);
  const bound = await createLocalBinding({ id: ID }, home);
  await fs.writeFile(path.join(path.dirname(file), "other.jsonl"), row("session_meta", { id: OTHER }) + message("user", "Different project"));
  await fs.unlink(file);
  const result = await readBoundThread(bound, { readThread: failingRead });
  assert.equal(result.access, "unavailable");
  assert.equal(result.target.id, ID);
  assert.equal(result.text, undefined);
});

test("archived records remain readable by fixed ID and lists stay separate", async (t) => {
  const { home, file } = await fixture(t);
  await fs.mkdir(path.join(home, "archived_sessions"));
  await fs.rename(file, path.join(home, "archived_sessions", "archived.jsonl"));
  assert.equal((await listLocalSessions(home)).threads.length, 0);
  assert.equal((await listLocalSessions(home, { archived: true })).threads[0].id, ID);
  assert.match((await readLocalSession(home, ID)).text, /36px/);
});

test("official read validates identity, clips long text, and does not expose unbounded messages to IPC", async (t) => {
  const { home } = await fixture(t);
  const bound = await createLocalBinding({ id: ID }, home);
  const wrong = await readBoundThread(bound, { readThread: async () => ({ id: OTHER, turns: [] }) });
  assert.equal(wrong.reason, "local_thread_identity_mismatch");
  const readThread = async () => ({ id: ID, name: "Project A", turns: [{ id: "1", items: [{ type: "userMessage", content: "x".repeat(4000) }] }] });
  const read = await readBoundThread(bound, { readThread, maxChars: 1500 });
  assert.equal(read.source, "codex-app-server");
  assert.equal(read.coverage.kind, "partial");
  assert.equal(read.messages, undefined);
  assert.ok(read.text.length <= 1500);
});

test("incomplete final line is partial; mid-file corruption and rollback are not accepted", async (t) => {
  const { home, file } = await fixture(t);
  const original = await fs.readFile(file, "utf8");
  await fs.appendFile(file, '{"type":');
  assert.equal((await readLocalSession(home, ID)).coverage.incompleteTail, true);
  await fs.appendFile(file, "\n" + message("user", "later"));
  await assert.rejects(readLocalSession(home, ID), /local_session_corrupt/);
  await fs.writeFile(file, original + row("event_msg", { type: "thread_rolled_back", num_turns: 1 }));
  await assert.rejects(readLocalSession(home, ID), /rollback_requires_app_server/);
});

test("cancelled primary read never silently starts fallback", async (t) => {
  const { home } = await fixture(t);
  const bound = await createLocalBinding({ id: ID }, home);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readBoundThread(bound, { signal: controller.signal, readThread: async () => { throw new Error("context_cancelled"); } }), /context_cancelled/);
});

test("history RPC permits only list/read, initializes first, deduplicates paginated real IDs", async (t) => {
  const { home } = await fixture(t);
  const mock = path.join(home, "mock-server.cjs");
  await fs.writeFile(mock, `const r=require('node:readline').createInterface({input:process.stdin});
    let initialized=false;
    r.on('line',l=>{const q=JSON.parse(l);const out=v=>process.stdout.write(JSON.stringify({id:q.id,result:v})+'\\n');
    if(q.method==='initialize') return out({});
    if(q.method==='initialized') {initialized=true;return;}
    if(!initialized||!['thread/list','thread/read'].includes(q.method)) process.exit(9);
    if(q.method==='thread/read') return out({thread:{id:q.params.threadId,turns:[]}});
    if(!q.params.cursor) return out({data:[{id:'${ID}',updatedAt:1},{id:'${ID}',updatedAt:2}],nextCursor:'next'});
    out({data:[{id:'${ID}',updatedAt:3},{id:'${OTHER}',updatedAt:4}],nextCursor:null});});`);
  const options = { command: { cli: process.execPath, args: [mock] }, codexHome: home, timeoutMs: 3000 };
  const listed = await listCodexThreads(options);
  assert.equal(listed.threads.length, 2);
  assert.equal(listed.threads.find((row) => row.id === ID).updatedAt, 3);
  assert.equal((await readCodexThread(ID, options)).id, ID);
  await assert.rejects(requestCodexHistory("turn/start", {}, options), /history_method_not_allowed/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readCodexThread(ID, { ...options, signal: controller.signal }), /context_cancelled/);
});
