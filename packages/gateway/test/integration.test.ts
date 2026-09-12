import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CSRF_HEADER, TOOL_NAMES, type ToolName } from "@tab-goblin/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createConfigStore } from "../../../plugin/server/config-store.js";
import { createGatewayManager } from "../../../plugin/server/gateway-client.js";
import { createLifecycleCoordinator } from "../../../plugin/server/lifecycle-coordinator.js";
import { tabGoblinSettingsSchema, type TabGoblinSettings } from "../../../plugin/shared/settings.js";
import { containerNameFor, volumeNameFor } from "../src/runtime.js";
import { runGateway, type GatewayApplication } from "../src/main.js";

const LIVE_IMAGE = process.env.TABGOBLIN_IMAGE;
const describeLive = LIVE_IMAGE ? describe : describe.skip;
const FIXTURE_PORT = 18_080;
const MAX_PODMAN_OUTPUT = 1024 * 1024;

interface PodmanResult { code: number; stdout: string; stderr: string }

function podman(args: string[]): PodmanResult {
  try {
    return { code: 0, stdout: execFileSync("podman", args, { encoding: "utf8", maxBuffer: MAX_PODMAN_OUTPUT }), stderr: "" };
  } catch (error: unknown) {
    const failure = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      code: failure.status ?? 1,
      stdout: Buffer.isBuffer(failure.stdout) ? failure.stdout.toString("utf8") : failure.stdout ?? "",
      stderr: Buffer.isBuffer(failure.stderr) ? failure.stderr.toString("utf8") : failure.stderr ?? "",
    };
  }
}

function requirePodman(args: string[]): string {
  const result = podman(args);
  if (result.code !== 0) throw new Error(`podman ${args[0]} failed: ${result.stderr.slice(-1000)}`);
  return result.stdout;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not reserve viewer port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

const FIXTURE_SOURCE = String.raw`
import { createServer } from "node:http";
function esc(value) { return value.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]); }
function cookie(req, name) { for (const part of (req.headers.cookie || "").split(";")) { const [key, value] = part.trim().split("="); if (key === name) return decodeURIComponent(value || ""); } return ""; }
async function body(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); }
function page(title, content) { return '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title></head><body>' + content + '</body></html>'; }
createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const send = (status, content, headers = {}) => { res.writeHead(status, {"content-type":"text/html; charset=utf-8", ...headers}); res.end(content); };
  if (url.pathname === "/ready") return send(200, "ready");
  if (url.pathname === "/" || url.pathname === "/form") return send(200, page("Controls", String.raw` + "`" + `
    <h1>Integration controls</h1>
    <label for="username">Username</label><input id="username">
    <label for="notes">Notes</label><textarea id="notes"></textarea>
    <label for="role">Role</label><select id="role"><option value="reader">Reader</option><option value="admin">Admin</option></select>
    <button id="apply" onclick="document.querySelector('#output').textContent='applied:'+document.querySelector('#username').value">Apply</button>
    <div id="source" role="button" aria-label="Drag source" draggable="true">Drag source</div>
    <div id="target" role="button" aria-label="Drop target">Drop target</div>
    <p id="output">idle</p><p id="delayed"></p>
    <script>
      console.log('fixture-ready'); fetch('/diagnostic?token=private#fragment');
      source.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain','moved'));
      target.addEventListener('dragover', e => e.preventDefault());
      target.addEventListener('drop', e => { e.preventDefault(); target.textContent=e.dataTransfer.getData('text/plain'); });
      setTimeout(() => delayed.textContent='manual-drain-ready', 1200);
    </script>` + "`" + `));
  if (url.pathname === "/diagnostic") return send(200, "diagnostic");
  if (url.pathname === "/second") return send(200, page("Second", '<h1>Second page</h1>'));
  if (url.pathname === "/login" && req.method === "GET") return send(200, page("Login", '<form method="post"><label for="login-user">Login user</label><input id="login-user" name="username"><label for="password">Password</label><input id="password" name="password" type="password"><button type="submit">Sign in</button></form>'));
  if (url.pathname === "/login" && req.method === "POST") { const form = new URLSearchParams((await body(req)).toString()); const user = form.get("username") || "anonymous"; return send(302, "", {location:"/account", "set-cookie":'tg_fixture_user='+encodeURIComponent(user)+'; Max-Age=3600; Path=/; SameSite=Lax'}); }
  if (url.pathname === "/account") { const user = cookie(req, "tg_fixture_user"); return user ? send(200, page("Account", '<h1>Signed in as '+esc(user)+'</h1>')) : send(401, page("Denied", '<h1>Not signed in</h1>')); }
  if (url.pathname === "/upload" && req.method === "GET") return send(200, page("Upload", '<form method="post" enctype="multipart/form-data"><label for="attachment">Attachment</label><input id="attachment" name="attachment" type="file" aria-label="Attachment"><button type="submit">Submit upload</button></form>'));
  if (url.pathname === "/upload" && req.method === "POST") {
    const payload = await body(req);
    const contentStart = payload.indexOf(Buffer.from("\\r\\n\\r\\n"));
    const contentEnd = payload.indexOf(Buffer.from("\\r\\n--"), contentStart + 4);
    if (contentStart < 0 || contentEnd < 0) return send(400, page("Invalid upload", "invalid multipart body"));
    const uploaded = payload.subarray(contentStart + 4, contentEnd);
    return send(200, page("Uploaded", '<p id="uploaded-bytes">'+uploaded.toString("hex")+'</p>'));
  }
  send(404, page("Missing", "missing"));
}).listen(${FIXTURE_PORT}, "127.0.0.1");
`;

async function installFixture(containerName: string, directory: string): Promise<void> {
  const fixturePath = join(directory, "loopback-fixture.mjs");
  await writeFile(fixturePath, FIXTURE_SOURCE);
  requirePodman(["cp", process.execPath, `${containerName}:/tmp/tabgoblin-live-node`]);
  const libatomic = /^\s*libatomic\.so\.1\s+=>\s+(\S+)/m.exec(execFileSync("ldd", [process.execPath], { encoding: "utf8" }))?.[1];
  if (libatomic) requirePodman(["cp", realpathSync(libatomic), `${containerName}:/tmp/libatomic.so.1`]);
  requirePodman(["cp", fixturePath, `${containerName}:/tmp/tabgoblin-integration-fixture.mjs`]);
  await startFixture(containerName);
}

async function startFixture(containerName: string): Promise<void> {
  requirePodman(["exec", "-d", containerName, "sh", "-c", "LD_LIBRARY_PATH=/tmp /tmp/tabgoblin-live-node /tmp/tabgoblin-integration-fixture.mjs >/tmp/tabgoblin-integration-fixture.log 2>&1"]);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = podman(["exec", "--env", "LD_LIBRARY_PATH=/tmp", containerName, "/tmp/tabgoblin-live-node", "-e", `fetch('http://127.0.0.1:${FIXTURE_PORT}/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`]);
    if (probe.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`fixture unavailable: ${podman(["exec", containerName, "sh", "-c", "tail -c 2000 /tmp/tabgoblin-integration-fixture.log 2>/dev/null || true"]).stdout}`);
}

interface ViewerAuth { cookie: string; csrf: string; workspaceId: string }

async function pairViewer(base: string, code: string): Promise<ViewerAuth> {
  const response = await fetch(`${base}/api/pair`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  expect(response.status).toBe(200);
  const value = await response.json() as { workspaceId: string; csrfToken: string; viewOnly: boolean };
  expect(value.viewOnly).toBe(true);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("pair response did not set a viewer cookie");
  return { cookie, csrf: value.csrfToken, workspaceId: value.workspaceId };
}

async function viewerRequest(base: string, auth: ViewerAuth, path: string, body: unknown = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: path === "/api/status" ? "GET" : "POST",
    headers: { origin: base, cookie: auth.cookie, [CSRF_HEADER]: auth.csrf, "content-type": "application/json" },
    body: path === "/api/status" ? undefined : JSON.stringify(body),
  });
}

async function connectRfb(base: string, auth: ViewerAuth): Promise<WebSocket> {
  const websocket = new WebSocket(`${base.replace("http", "ws")}/ws/vnc?workspaceId=${encodeURIComponent(auth.workspaceId)}`, {
    headers: { origin: base, cookie: auth.cookie },
  });
  const chunks: Buffer[] = [];
  websocket.on("message", (data) => chunks.push(Buffer.from(data as Buffer)));
  await new Promise<void>((resolve, reject) => { websocket.once("open", resolve); websocket.once("error", reject); });
  const take = async (length: number): Promise<Buffer> => {
    const deadline = Date.now() + 10_000;
    while (Buffer.concat(chunks).length < length) {
      if (Date.now() >= deadline) throw new Error("RFB handshake timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const all = Buffer.concat(chunks); chunks.length = 0; if (all.length > length) chunks.push(all.subarray(length));
    return all.subarray(0, length);
  };
  expect((await take(12)).toString()).toBe("RFB 003.008\n");
  websocket.send(Buffer.from("RFB 003.008\n"));
  const securityTypes = await take(2);
  expect([...securityTypes]).toEqual([1, 1]);
  websocket.send(Buffer.from([1]));
  expect(await take(4)).toEqual(Buffer.alloc(4));
  websocket.send(Buffer.from([1]));
  await take(24);
  return websocket;
}

function keyEvent(keysym: number, down: boolean): Buffer {
  const frame = Buffer.alloc(8); frame[0] = 4; frame[1] = down ? 1 : 0; frame.writeUInt32BE(keysym, 4); return frame;
}

function closeWebSocket(websocket: WebSocket): Promise<void> {
  if (websocket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => { websocket.once("close", () => resolve()); websocket.close(); });
}

function textContent(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("tool did not return text content");
  return first.text;
}

function jsonContent<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  return JSON.parse(textContent(result)) as T;
}

async function expectToolError(client: Client, name: ToolName, args: Record<string, unknown>, code: string): Promise<void> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  expect(jsonContent<{ code: string }>(result).code).toBe(code);
}

describeLive(`TabGoblin integrated runtime${LIVE_IMAGE ? "" : " (skipped: set TABGOBLIN_IMAGE)"}`, () => {
  const workspaceId = `t16-${randomUUID()}`;
  const otherWorkspaceId = `t16-other-${randomUUID()}`;
  const agentId = `agent-${randomUUID()}`;
  const cwd = `/tmp/${workspaceId}`;
  const containerName = containerNameFor(workspaceId);
  const profileVolume = volumeNameFor(workspaceId);
  const stagingVolume = `${profileVolume}-staging`;
  const fixtureUrl = `http://127.0.0.1:${FIXTURE_PORT}`;
  let directory = "";
  let app: GatewayApplication | undefined;
  let gateway = undefined as ReturnType<typeof createGatewayManager> | undefined;
  let lifecycle = undefined as ReturnType<typeof createLifecycleCoordinator> | undefined;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let viewerPort = 0;
  let base = "";
  let activeEnrollment = "";
  const pluginStateDirectory = () => join(directory, "plugin-state");
  const viewers = new Set<WebSocket>();

  async function openBridge(enrollment: string): Promise<Client> {
    const bridgePath = fileURLToPath(new URL("../../mcp-bridge/dist/index.js", import.meta.url));
    await stat(bridgePath);
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [bridgePath],
      env: { ...process.env, TABGOBLIN_SOCKET: app!.socketPath, TABGOBLIN_ENROLLMENT: enrollment } as Record<string, string>,
      stderr: "pipe",
    });
    const next = new Client({ name: "tabgoblin-t16", version: "1.0.0" });
    await next.connect(transport);
    client = next;
    return next;
  }

  async function readPersistedPluginSettings(): Promise<TabGoblinSettings> {
    return tabGoblinSettingsSchema.parse(JSON.parse(await readFile(join(pluginStateDirectory(), "settings.json"), "utf8")));
  }

  function reloadPluginLifecycle(): void {
    const store = createConfigStore(pluginStateDirectory());
    gateway = createGatewayManager(() => store.read().socketPath);
    lifecycle = createLifecycleCoordinator(store, gateway);
  }

  async function openPersistedPluginSession(enrollment: string) {
    activeEnrollment = enrollment;
    const scope = await lifecycle!.openSession({ agentId, workspaceId, cwd, purpose: "interactive", enrollment });
    const persisted = await readFile(join(pluginStateDirectory(), "settings.json"), "utf8");
    expect(persisted).not.toContain(enrollment);
    const bridge = scope?.socketPath === app!.socketPath ? await openBridge(enrollment) : undefined;
    return { bridge, scope };
  }

  async function setupPluginSession(enrollment: string) {
    const store = createConfigStore(pluginStateDirectory());
    await store.update((current) => ({ ...current, enabled: true, socketPath: app!.socketPath, bridgeCommand: process.execPath, bridgeArgs: [fileURLToPath(new URL("../../mcp-bridge/dist/index.js", import.meta.url))] }));
    gateway = createGatewayManager(() => store.read().socketPath);
    lifecycle = createLifecycleCoordinator(store, gateway);
    expect(await lifecycle.enableWorkspace(workspaceId, cwd)).toEqual({ ok: true });
    const opened = await openPersistedPluginSession(enrollment);
    expect(opened.bridge, "initial plugin lifecycle did not enroll the session").toBeDefined();
    return { bridge: opened.bridge!, scope: opened.scope! };
  }

  async function reopenPluginSession(enrollment: string) {
    reloadPluginLifecycle();
    return openPersistedPluginSession(enrollment);
  }

  async function expectMissingConfigStaysClosed(): Promise<void> {
    const store = createConfigStore(join(directory, "missing-plugin-state"));
    const manager = createGatewayManager(() => store.read().socketPath);
    const coordinator = createLifecycleCoordinator(store, manager);
    expect(await coordinator.openSession({ agentId, workspaceId, cwd, purpose: "interactive", enrollment: randomUUID() })).toBeUndefined();
    expect(store.read()).toMatchObject({ enabled: false, enabledWorkspaceCwds: [], agentGenerations: {}, workspaceGenerations: {} });
    await expect(stat(store.path)).rejects.toMatchObject({ code: "ENOENT" });
    manager.close();
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "tabgoblin-t16-"));
    await mkdir(cwd, { recursive: true });
    viewerPort = await reserveLoopbackPort();
    base = `http://127.0.0.1:${viewerPort}`;
    app = await runGateway({ xdgRuntimeDir: directory, viewerPort, viewerOrigins: [base], image: LIVE_IMAGE! });
  }, 120_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const viewer of viewers) await closeWebSocket(viewer).catch((error: unknown) => failures.push(error));
    await client?.close().catch((error: unknown) => failures.push(error));
    gateway?.close();
    await app?.close().catch((error: unknown) => failures.push(error));
    const cleanup = podman(["rm", "--force", "--ignore", containerName]);
    if (cleanup.code !== 0) failures.push(new Error(cleanup.stderr));
    const volumes = podman(["volume", "rm", "--force", profileVolume, stagingVolume]);
    if (volumes.code !== 0 && !/no such volume/i.test(volumes.stderr)) failures.push(new Error(volumes.stderr));
    if (directory) await rm(directory, { recursive: true, force: true }).catch((error: unknown) => failures.push(error));
    await rm(cwd, { recursive: true, force: true }).catch((error: unknown) => failures.push(error));
    if (failures.length > 0) throw new AggregateError(failures, "T16 live fixture cleanup failed");
  }, 120_000);

  it("drives all 25 stdio MCP tools through the real gateway and preserves scoped privacy", async () => {
    await expectMissingConfigStaysClosed();
    const { bridge } = await setupPluginSession(randomUUID());
    const listed = await bridge.listTools();
    expect(listed.tools.map(({ name }) => name).sort()).toEqual([...TOOL_NAMES].sort());
    const called = new Set<ToolName>();
    const call = async (name: ToolName, args: Record<string, unknown> = {}) => {
      called.add(name);
      const result = await bridge.callTool({ name, arguments: args });
      expect(result.isError, `${name}: ${result.content.map((item) => item.type === "text" ? item.text : item.type).join(" ")}`).not.toBe(true);
      return result;
    };

    expect(jsonContent<{ sessionState: string }>(await call("tabgoblin_start")).sessionState).toBe("ready");
    await installFixture(containerName, directory);
    expect(jsonContent<{ sessionState: string }>(await call("tabgoblin_status")).sessionState).toBe("ready");

    const tab = jsonContent<{ tabId: string }>(await call("tabgoblin_new_tab", { url: `${fixtureUrl}/form?token=private#fragment` }));
    await call("tabgoblin_wait", { tabId: tab.tabId, condition: "load", timeoutMs: 5000 });
    let snapshot = jsonContent<{ nodes: Array<{ role: string; name: string; ref: string }> }>(await call("tabgoblin_snapshot", { tabId: tab.tabId }));
    const ref = (name: string) => {
      const node = snapshot.nodes.find((candidate) => candidate.name === name);
      if (!node) throw new Error(`missing accessibility node ${name}`);
      return node.ref;
    };
    await call("tabgoblin_fill", { tabId: tab.tabId, ref: ref("Username"), value: "ada", timeoutMs: 5000 });
    await call("tabgoblin_type", { tabId: tab.tabId, ref: ref("Notes"), text: "typed note", timeoutMs: 5000 });
    await call("tabgoblin_keypress", { tabId: tab.tabId, key: "End", timeoutMs: 5000 });
    await call("tabgoblin_select", { tabId: tab.tabId, ref: ref("Role"), values: ["admin"], timeoutMs: 5000 });
    await call("tabgoblin_hover", { tabId: tab.tabId, ref: ref("Apply"), timeoutMs: 5000 });
    await call("tabgoblin_drag", { tabId: tab.tabId, fromRef: ref("Drag source"), toRef: ref("Drop target"), timeoutMs: 5000 });
    await call("tabgoblin_scroll", { tabId: tab.tabId, dx: 0, dy: 100 });
    await call("tabgoblin_click", { tabId: tab.tabId, ref: ref("Apply"), timeoutMs: 5000 });
    const evaluated = jsonContent<string>(await call("tabgoblin_evaluate", { tabId: tab.tabId, expression: "({user:username.value,notes:notes.value,role:role.value,drop:target.textContent,output:output.textContent})", maxChars: 1000 }));
    expect(JSON.parse(evaluated)).toEqual({ user: "ada", notes: "typed note", role: "admin", drop: "moved", output: "applied:ada" });
    expect(jsonContent<string>(await call("tabgoblin_text", { tabId: tab.tabId, maxChars: 2000 }))).toContain("applied:ada");
    expect(jsonContent<string[]>(await call("tabgoblin_logs", { tabId: tab.tabId, maxEntries: 20 }))).toContain("log: fixture-ready");
    const network = jsonContent<Array<{ method: string; url: string; status: number }>>(await call("tabgoblin_network", { tabId: tab.tabId, maxEntries: 20 }));
    expect(network.some((entry) => entry.url === `${fixtureUrl}/diagnostic` && entry.status === 200)).toBe(true);
    expect(JSON.stringify(network)).not.toContain("private");
    const screenshot = await call("tabgoblin_screenshot", { tabId: tab.tabId, fullPage: false });
    expect(screenshot.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });

    await call("tabgoblin_navigate", { tabId: tab.tabId, url: `${fixtureUrl}/second`, timeoutMs: 5000 });
    await call("tabgoblin_navigate", { tabId: tab.tabId, url: `${fixtureUrl}/upload`, timeoutMs: 5000 });
    // Forward at the newest history entry is an intentional, bounded no-op.
    expect(jsonContent<{ title: string }>(await call("tabgoblin_forward", { tabId: tab.tabId, timeoutMs: 5000 })).title).toBe("Upload");
    expect(jsonContent<{ title: string }>(await call("tabgoblin_reload", { tabId: tab.tabId, timeoutMs: 5000 })).title).toBe("Upload");
    expect(jsonContent<{ title: string }>(await call("tabgoblin_back", { tabId: tab.tabId, timeoutMs: 5000 })).title).toBe("Second");
    expect(jsonContent<{ title: string }>(await call("tabgoblin_forward", { tabId: tab.tabId, timeoutMs: 5000 })).title).toBe("Upload");
    snapshot = jsonContent(await call("tabgoblin_snapshot", { tabId: tab.tabId }));
    const uploadPath = join(cwd, "meaningful-upload.bin");
    const uploadBytes = Buffer.from([0x00, 0x01, 0x02, 0x0a, 0x0d, 0x41, 0x7f, 0x80, 0xfe, 0xff]);
    await writeFile(uploadPath, uploadBytes);
    const attachment = snapshot.nodes.find((node) => node.name === "Attachment" && node.role === "textbox");
    if (!attachment) throw new Error(`missing file input: ${JSON.stringify(snapshot.nodes)}`);
    await call("tabgoblin_upload", { tabId: tab.tabId, ref: attachment.ref, path: uploadPath });
    const selectedFile = JSON.parse(jsonContent<string>(await call("tabgoblin_evaluate", {
      tabId: tab.tabId,
      expression: "({name:attachment.files[0].name,size:attachment.files[0].size})",
      maxChars: 200,
    }))) as { name: string; size: number };
    expect(selectedFile).toEqual({ name: "meaningful-upload.bin", size: uploadBytes.length });
    snapshot = jsonContent(await call("tabgoblin_snapshot", { tabId: tab.tabId }));
    await call("tabgoblin_click", { tabId: tab.tabId, ref: ref("Submit upload"), timeoutMs: 5000 });
    expect(jsonContent<string>(await call("tabgoblin_text", { tabId: tab.tabId, maxChars: 1000 }))).toContain(uploadBytes.toString("hex"));

    const temporaryTab = jsonContent<{ tabId: string }>(await call("tabgoblin_new_tab", { url: `${fixtureUrl}/second` }));
    await call("tabgoblin_close_tab", { tabId: temporaryTab.tabId });
    expect(jsonContent<Array<{ tabId: string }>>(await call("tabgoblin_list_tabs")).some((item) => item.tabId === temporaryTab.tabId)).toBe(false);

    const directCrossScope = await gateway!.request({ op: "tool", enrollment: activeEnrollment, workspaceId: otherWorkspaceId, name: "tabgoblin_status", input: {}, source: "t16-cross-scope" });
    expect(directCrossScope).toMatchObject({ ok: false, error: { code: "auth_failed" } });
    expect(called).toEqual(new Set(TOOL_NAMES));
  }, 180_000);

  it("enforces pairing, view-only RFB handshake, contention, drain, reconnect, generations, plugin reload, and restart persistence", async () => {
    const initialBridge = client!;
    await lifecycle!.cleanup();
    await expectToolError(initialBridge, "tabgoblin_status", {}, "not_enrolled");
    await initialBridge.close(); client = undefined; gateway!.close();
    const initialReload = await reopenPluginSession(randomUUID());
    expect(initialReload.bridge, "persisted plugin lifecycle did not reopen").toBeDefined();
    expect(initialReload.scope!.agentGeneration).toBeGreaterThan(0);
    expect(initialReload.scope!.workspaceGeneration).toBeGreaterThan(0);
    const initialReloadSettings = await readPersistedPluginSettings();
    expect(initialReloadSettings.enabled).toBe(true);
    expect(initialReloadSettings.enabledWorkspaceCwds).toContain(cwd);
    expect(initialReloadSettings.agentGenerations[agentId]).toBe(initialReload.scope!.agentGeneration);
    expect(initialReloadSettings.workspaceGenerations[workspaceId]).toBe(initialReload.scope!.workspaceGeneration);
    const bridge = initialReload.bridge!;

    // Recreate the runtime once before login; this proves an enrolled bridge can
    // start the same persistent profile after an ordinary stop.
    expect(await gateway!.request({ op: "stop", workspaceId })).toEqual({ ok: true });
    const restarted = await bridge.callTool({ name: "tabgoblin_start", arguments: {} });
    expect(restarted.isError, textContent(restarted)).not.toBe(true);
    expect(jsonContent<{ sessionState: string }>(restarted).sessionState).toBe("ready");
    await installFixture(containerName, directory);
    const tab = jsonContent<{ tabId: string }>(await bridge.callTool({ name: "tabgoblin_new_tab", arguments: { url: `${fixtureUrl}/login` } }));
    let snapshot = jsonContent<{ nodes: Array<{ name: string; role: string; ref: string }> }>(await bridge.callTool({ name: "tabgoblin_snapshot", arguments: { tabId: tab.tabId } }));
    const field = snapshot.nodes.find((node) => node.name === "Login user")!;
    const password = snapshot.nodes.find((node) => node.name === "Password")!;
    const submit = snapshot.nodes.find((node) => node.role === "button")!;
    await bridge.callTool({ name: "tabgoblin_fill", arguments: { tabId: tab.tabId, ref: field.ref, value: "grace", timeoutMs: 5000 } });
    await bridge.callTool({ name: "tabgoblin_fill", arguments: { tabId: tab.tabId, ref: password.ref, value: "fixture-only", timeoutMs: 5000 } });
    await bridge.callTool({ name: "tabgoblin_click", arguments: { tabId: tab.tabId, ref: submit.ref, timeoutMs: 5000 } });
    expect(jsonContent<string>(await bridge.callTool({ name: "tabgoblin_text", arguments: { tabId: tab.tabId, maxChars: 1000 } }))).toContain("Signed in as grace");

    const staticViewer = await fetch(base);
    expect(staticViewer.status).toBe(200);
    expect(await staticViewer.text()).toContain("TabGoblin");
    expect((await fetch(`${base}/api/status`)).status).toBe(403);

    const firstPair = await gateway!.request({ op: "pair", workspaceId });
    if (!firstPair.ok || !firstPair.pairingCode) throw new Error("gateway did not issue first pairing code");
    const firstAuth = await pairViewer(base, firstPair.pairingCode);
    const replay = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ code: firstPair.pairingCode }),
    });
    expect(replay.status).toBe(401);
    const firstSocket = await connectRfb(base, firstAuth); viewers.add(firstSocket);

    await bridge.callTool({ name: "tabgoblin_navigate", arguments: { tabId: tab.tabId, url: `${fixtureUrl}/form`, timeoutMs: 5000 } });
    snapshot = jsonContent(await bridge.callTool({ name: "tabgoblin_snapshot", arguments: { tabId: tab.tabId } }));
    const usernameRef = snapshot.nodes.find((node) => node.name === "Username")!.ref;
    const oldRef = snapshot.nodes.find((node) => node.name === "Apply")!.ref;
    await bridge.callTool({ name: "tabgoblin_click", arguments: { tabId: tab.tabId, ref: usernameRef, timeoutMs: 5000 } });
    firstSocket.send(keyEvent(0x41, true));
    firstSocket.send(keyEvent(0x41, false));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(jsonContent<string>(await bridge.callTool({ name: "tabgoblin_evaluate", arguments: { tabId: tab.tabId, expression: "username.value", maxChars: 100 } }))).toBe('""');
    const beforeTakeover = jsonContent<{ ownership: { generation: number } }>(await bridge.callTool({ name: "tabgoblin_status", arguments: {} })).ownership.generation;
    const wait = bridge.callTool({ name: "tabgoblin_wait", arguments: { tabId: tab.tabId, condition: "text", text: "manual-drain-ready", timeoutMs: 5000 } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const takeoverStarted = Date.now();
    const takeover = viewerRequest(base, firstAuth, "/api/take-control");
    expect((await wait).isError).not.toBe(true);
    const takeoverResponse = await takeover;
    expect(takeoverResponse.status).toBe(200);
    expect(Date.now() - takeoverStarted).toBeGreaterThan(500);
    const takeoverStatus = await takeoverResponse.json() as { ownership: { state: string; owner: string | null; generation: number }; isOwner: boolean };
    expect(takeoverStatus).toMatchObject({ ownership: { state: "manual", owner: "viewer" }, isOwner: true });
    firstSocket.send(keyEvent(0x62, true));
    firstSocket.send(keyEvent(0x62, false));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expectToolError(bridge, "tabgoblin_text", { tabId: tab.tabId, maxChars: 1000 }, "manual_control");
    expect(jsonContent<{ ownership: { state: string } }>(await bridge.callTool({ name: "tabgoblin_status", arguments: {} })).ownership.state).toBe("manual");

    const secondPair = await gateway!.request({ op: "pair", workspaceId });
    if (!secondPair.ok || !secondPair.pairingCode) throw new Error("gateway did not issue second pairing code");
    const secondAuth = await pairViewer(base, secondPair.pairingCode);
    const secondSocket = await connectRfb(base, secondAuth); viewers.add(secondSocket);
    expect((await viewerRequest(base, secondAuth, "/api/take-control")).status).toBe(503);
    const reclaimResponse = await viewerRequest(base, secondAuth, "/api/reclaim", { confirm: true });
    expect(reclaimResponse.status).toBe(200);
    const reclaimStatus = await reclaimResponse.json() as { ownership: { generation: number } };
    expect(await (await viewerRequest(base, firstAuth, "/api/status")).json()).toMatchObject({ isOwner: false });
    expect(await (await viewerRequest(base, secondAuth, "/api/status")).json()).toMatchObject({ isOwner: true });

    await closeWebSocket(secondSocket); viewers.delete(secondSocket);
    const reconnected = await connectRfb(base, secondAuth); viewers.add(reconnected);
    reconnected.send(keyEvent(0xffe3, true));
    const returnResponse = await viewerRequest(base, secondAuth, "/api/return-to-agent");
    expect(returnResponse.status).toBe(200);
    const returnedStatus = await returnResponse.json() as { ownership: { state: string; owner: string | null; generation: number } };
    expect(returnedStatus).toMatchObject({ ownership: { state: "agent-ready" } });
    await expectToolError(bridge, "tabgoblin_click", { tabId: tab.tabId, ref: oldRef, timeoutMs: 5000 }, "stale_ref");
    const freshSnapshot = jsonContent<{ nodes: Array<{ name: string; ref: string }> }>(await bridge.callTool({ name: "tabgoblin_snapshot", arguments: { tabId: tab.tabId } }));
    expect(freshSnapshot.nodes.find((node) => node.name === "Apply")?.ref).not.toBe(oldRef);
    expect(jsonContent<string>(await bridge.callTool({ name: "tabgoblin_evaluate", arguments: { tabId: tab.tabId, expression: "username.value", maxChars: 100 } }))).toBe('"b"');
    expect((await gateway!.request({ op: "activity", workspaceId })).activity?.map((item) => item.action)).toEqual(expect.arrayContaining(["manual-take-control", "manual-reclaim", "manual-return-to-agent"]));

    const runningBeforeReload = requirePodman(["inspect", "--format", "{{.State.Running}}", containerName]).trim();
    expect(runningBeforeReload).toBe("true");
    const durableBeforeCleanup = await readPersistedPluginSettings();
    expect(durableBeforeCleanup.enabled).toBe(true);
    expect(durableBeforeCleanup.enabledWorkspaceCwds).toContain(cwd);
    expect(durableBeforeCleanup.activeAgentIds).toContain(agentId);
    expect(durableBeforeCleanup.agentGenerations[agentId]).toBeGreaterThan(0);
    expect(durableBeforeCleanup.workspaceGenerations[workspaceId]).toBeGreaterThan(0);
    expect(durableBeforeCleanup.gatewayInstanceId).toMatch(/^[0-9a-f-]{36}$/);

    await lifecycle!.cleanup();
    const durableAfterCleanup = await readPersistedPluginSettings();
    expect(durableAfterCleanup.enabled).toBe(true);
    expect(durableAfterCleanup.enabledWorkspaceCwds).toContain(cwd);
    expect(durableAfterCleanup.agentGenerations[agentId]).toBeGreaterThan(durableBeforeCleanup.agentGenerations[agentId]);
    expect(durableAfterCleanup.workspaceGenerations[workspaceId]).toBeGreaterThan(durableBeforeCleanup.workspaceGenerations[workspaceId]);
    expect(durableAfterCleanup.rotatingAgentIds).toContain(agentId);
    expect(durableAfterCleanup.rotatingWorkspaceIds).toContain(workspaceId);
    await expectToolError(bridge, "tabgoblin_status", {}, "not_enrolled");
    await bridge.close(); client = undefined; gateway!.close();
    expect(requirePodman(["inspect", "--format", "{{.State.Running}}", containerName]).trim()).toBe("true");

    expect(await readPersistedPluginSettings()).toEqual(durableAfterCleanup);
    const postReload = await reopenPluginSession(randomUUID());
    expect(postReload.bridge, "plugin reload did not recover persisted lifecycle state").toBeDefined();
    expect(postReload.scope!.agentGeneration).toBeGreaterThan(durableAfterCleanup.agentGenerations[agentId]);
    expect(postReload.scope!.workspaceGeneration).toBeGreaterThan(durableAfterCleanup.workspaceGenerations[workspaceId]);
    const durableAfterReload = await readPersistedPluginSettings();
    expect(durableAfterReload.enabled).toBe(true);
    expect(durableAfterReload.enabledWorkspaceCwds).toContain(cwd);
    expect(durableAfterReload.gatewayInstanceId).toBe(durableBeforeCleanup.gatewayInstanceId);
    expect(durableAfterReload.agentGenerations[agentId]).toBe(postReload.scope!.agentGeneration);
    expect(durableAfterReload.workspaceGenerations[workspaceId]).toBe(postReload.scope!.workspaceGeneration);
    const postReloadBridge = postReload.bridge!;
    expect(jsonContent<{ sessionState: string }>(await postReloadBridge.callTool({ name: "tabgoblin_status", arguments: {} })).sessionState).toBe("ready");

    const oldTabIds = jsonContent<Array<{ tabId: string }>>(await postReloadBridge.callTool({ name: "tabgoblin_list_tabs", arguments: {} })).map(({ tabId }) => tabId);
    expect(oldTabIds.length).toBeGreaterThan(0);
    const staleViewerCookie = secondAuth.cookie;
    const durableBeforeGatewayRestart = await readPersistedPluginSettings();
    await postReloadBridge.close(); client = undefined; gateway!.close();
    await app!.close(); app = undefined;
    requirePodman(["restart", containerName]);
    await startFixture(containerName);

    app = await runGateway({ xdgRuntimeDir: directory, viewerPort, viewerOrigins: [base], image: LIVE_IMAGE! });
    expect(await readPersistedPluginSettings()).toEqual(durableBeforeGatewayRestart);
    reloadPluginLifecycle();
    expect(lifecycle!.settings()).toEqual(durableBeforeGatewayRestart);
    const freshHealth = await gateway!.request({ op: "health" });
    if (!freshHealth.ok || !freshHealth.gatewayInstanceId) throw new Error("fresh gateway omitted its instance ID");
    expect(freshHealth.gatewayInstanceId).not.toBe(durableBeforeGatewayRestart.gatewayInstanceId);
    const recoveredSession = await openPersistedPluginSession(randomUUID());
    expect(recoveredSession.bridge, "fresh gateway did not reconcile persisted lifecycle state").toBeDefined();
    expect(recoveredSession.scope!.agentGeneration).toBeGreaterThan(0);
    expect(recoveredSession.scope!.workspaceGeneration).toBeGreaterThan(0);
    const durableAfterGatewayRestart = await readPersistedPluginSettings();
    expect(durableAfterGatewayRestart.enabled).toBe(true);
    expect(durableAfterGatewayRestart.enabledWorkspaceCwds).toContain(cwd);
    expect(durableAfterGatewayRestart.gatewayInstanceId).toBe(freshHealth.gatewayInstanceId);
    expect(durableAfterGatewayRestart.agentGenerations[agentId]).toBe(recoveredSession.scope!.agentGeneration);
    expect(durableAfterGatewayRestart.workspaceGenerations[workspaceId]).toBe(recoveredSession.scope!.workspaceGeneration);
    const recovered = recoveredSession.bridge!;
    expect(jsonContent<{ sessionState: string }>(await recovered.callTool({ name: "tabgoblin_start", arguments: {} })).sessionState).toBe("ready");
    expect((await fetch(`${base}/api/status`, { headers: { cookie: staleViewerCookie, [CSRF_HEADER]: secondAuth.csrf } })).status).toBe(403);
    const tabsAfterRestart = jsonContent<Array<{ tabId: string }>>(await recovered.callTool({ name: "tabgoblin_list_tabs", arguments: {} }));
    const restartedIds = tabsAfterRestart.map(({ tabId }) => tabId);
    expect(restartedIds.length).toBeGreaterThan(0);
    expect(new Set(restartedIds).size).toBe(restartedIds.length);
    expect(restartedIds.filter((tabId) => oldTabIds.includes(tabId))).toEqual([]);
    const account = jsonContent<{ tabId: string }>(await recovered.callTool({ name: "tabgoblin_new_tab", arguments: { url: `${fixtureUrl}/account` } }));
    expect(jsonContent<string>(await recovered.callTool({ name: "tabgoblin_text", arguments: { tabId: account.tabId, maxChars: 1000 } }))).toContain("Signed in as grace");

    const navigateSecond = await recovered.callTool({ name: "tabgoblin_navigate", arguments: { tabId: account.tabId, url: `${fixtureUrl}/second`, timeoutMs: 5000 } });
    expect(navigateSecond.isError, textContent(navigateSecond)).not.toBe(true);
    const navigateUpload = await recovered.callTool({ name: "tabgoblin_navigate", arguments: { tabId: account.tabId, url: `${fixtureUrl}/upload`, timeoutMs: 5000 } });
    expect(navigateUpload.isError, textContent(navigateUpload)).not.toBe(true);
    const historyBack = await recovered.callTool({ name: "tabgoblin_back", arguments: { tabId: account.tabId, timeoutMs: 5000 } });
    expect(historyBack.isError, textContent(historyBack)).not.toBe(true);
    expect(jsonContent<{ title: string }>(historyBack).title).toBe("Second");

    const stopped = await gateway!.request({ op: "stop", workspaceId });
    expect(stopped).toEqual({ ok: true });
    expect(podman(["volume", "exists", profileVolume]).code).toBe(0);

    expect(await lifecycle!.disableWorkspace(workspaceId, cwd)).toEqual({ ok: true });
    await expectToolError(recovered, "tabgoblin_status", {}, "not_enrolled");
    await recovered.close(); client = undefined; gateway!.close();
    await app!.close(); app = undefined;
    app = await runGateway({ xdgRuntimeDir: directory, viewerPort, viewerOrigins: [base], image: LIVE_IMAGE! });
    const optedOut = await reopenPluginSession(randomUUID());
    expect(optedOut).toEqual({ bridge: undefined, scope: undefined });
    expect(lifecycle!.settings().enabledWorkspaceCwds).not.toContain(cwd);
    expect(lifecycle!.settings().revokedWorkspaceIds).toContain(workspaceId);

    const ownershipGenerations = {
      beforeTakeover,
      afterTakeover: takeoverStatus.ownership.generation,
      afterReclaim: reclaimStatus.ownership.generation,
      afterReturn: returnedStatus.ownership.generation,
    };
    expect({
      takeoverAdvanced: ownershipGenerations.afterTakeover > ownershipGenerations.beforeTakeover,
      reclaimAdvanced: ownershipGenerations.afterReclaim > ownershipGenerations.afterTakeover,
      returnAdvanced: ownershipGenerations.afterReturn > ownershipGenerations.afterReclaim,
    }, `ownership generations: ${JSON.stringify(ownershipGenerations)}`).toEqual({
      takeoverAdvanced: true,
      reclaimAdvanced: true,
      returnAdvanced: true,
    });
  }, 300_000);
});
