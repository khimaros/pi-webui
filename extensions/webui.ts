/**
 * webui extension
 *
 * provides a /webui command to control the pi-webui server.
 *
 * usage:
 * /webui            - show interactive picker
 * /webui start      - launch the server
 * /webui status     - check if the server is running
 * /webui stop       - stop the server
 * /webui open       - open the webui in the default browser
 */

import { spawn, exec } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

const PID_FILE = join(homedir(), ".pi", "extensions", "webui.pid");
const WEBUI_URL = "http://127.0.0.1:8787";

const SUBCOMMANDS: Array<{ name: string; label: string }> = [
	{ name: "start", label: "/webui start  - launch the server" },
	{ name: "status", label: "/webui status - check server status" },
	{ name: "stop", label: "/webui stop   - stop the server" },
	{ name: "open", label: "/webui open   - open webui in browser" },
];

function getPid(): number | null {
	try {
		if (existsSync(PID_FILE)) {
			return parseInt(readFileSync(PID_FILE, "utf8").trim(), 10) || null;
		}
	} catch {
		/* ignore */
	}
	return null;
}

function setPid(pid: number) {
	try {
		const dir = dirname(PID_FILE);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(PID_FILE, pid.toString());
	} catch (error) {
		console.error(`failed to write pid file: ${error}`);
	}
}

function clearPid() {
	try {
		if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
	} catch {
		/* ignore */
	}
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function openUrl(url: string) {
	const platform = process.platform;
	let command = "";
	if (platform === "darwin") command = `open "${url}"`;
	else if (platform === "win32") command = `start "" "${url}"`;
	else command = `xdg-open "${url}"`;

	exec(command);
}

function runStart(ctx: ExtensionCommandContext) {
	const pid = getPid();
	if (pid && isRunning(pid)) {
		ctx.ui.notify(`pi-webui is already running (pid: ${pid})`, "info");
		return;
	}
	try {
		const __dirname = dirname(fileURLToPath(import.meta.url));
		const serverPath = join(__dirname, "..", "server.mjs");
		const child = spawn("node", [serverPath], { detached: true, stdio: "ignore" });
		const newPid = child.pid!;
		setPid(newPid);
		child.unref();
		ctx.ui.notify(`launching pi-webui server at ${WEBUI_URL}`, "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`failed to launch pi-webui: ${message}`, "error");
	}
}

function runStatus(ctx: ExtensionCommandContext) {
	const pid = getPid();
	if (pid && isRunning(pid)) {
		ctx.ui.notify(`pi-webui is running (pid: ${pid})`, "info");
	} else {
		ctx.ui.notify("pi-webui is not running", "info");
	}
}

function runStop(ctx: ExtensionCommandContext) {
	const pid = getPid();
	if (!pid || !isRunning(pid)) {
		ctx.ui.notify("pi-webui is not running", "info");
		return;
	}
	try {
		process.kill(pid, "SIGTERM");
		clearPid();
		ctx.ui.notify(`stopped pi-webui (pid: ${pid})`, "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`failed to stop pi-webui: ${message}`, "error");
	}
}

function runOpen(ctx: ExtensionCommandContext) {
	const pid = getPid();
	if (!pid || !isRunning(pid)) {
		ctx.ui.notify("pi-webui is not running. run /webui start first.", "error");
		return;
	}
	openUrl(WEBUI_URL);
	ctx.ui.notify(`opening ${WEBUI_URL} in browser`, "info");
}

function dispatch(name: string, ctx: ExtensionCommandContext): boolean {
	switch (name) {
		case "start": runStart(ctx); return true;
		case "status": runStatus(ctx); return true;
		case "stop": runStop(ctx); return true;
		case "open": runOpen(ctx); return true;
		default: return false;
	}
}

async function pickAndRun(ctx: ExtensionCommandContext) {
	const labels = SUBCOMMANDS.map((s) => s.label);
	const selected = await ctx.ui.select("pi-webui", labels);
	if (!selected) return;
	const sub = SUBCOMMANDS.find((s) => s.label === selected);
	if (sub) dispatch(sub.name, ctx);
}

export default function webuiExtension(pi: ExtensionAPI) {
	pi.registerCommand("webui", {
		description: "control the pi-webui server",
		handler: async (args, ctx) => {
			const command = (args || "").trim().toLowerCase();

			if (!command || command === "help") {
				await pickAndRun(ctx);
				return;
			}

			if (!dispatch(command, ctx)) {
				ctx.ui.notify(`unknown subcommand: ${command}`, "error");
				await pickAndRun(ctx);
			}
		},
	});
}
