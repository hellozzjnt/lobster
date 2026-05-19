function createInvokeCommand(commandName: string) {
  return {
    name: commandName,
    meta: {
      description: "Call a local OpenClaw tool endpoint",
      argsSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "OpenClaw control URL (or OPENCLAW_URL / CLAWD_URL)",
          },
          token: { type: "string", description: "Bearer token (or OPENCLAW_TOKEN / CLAWD_TOKEN)" },
          tool: { type: "string", description: "Tool name (e.g. message, cron, github, etc.)" },
          action: { type: "string", description: "Tool action" },
          "args-json": { type: "string", description: "JSON string of tool args" },
          sessionKey: { type: "string", description: "Optional session key attribution" },
          "session-key": { type: "string", description: "Alias for sessionKey" },
          dryRun: { type: "boolean", description: "Dry run" },
          "dry-run": { type: "boolean", description: "Alias for dryRun" },
          each: { type: "boolean", description: "Map each pipeline item into tool args" },
          itemKey: {
            type: "string",
            description: "Key to set from the pipeline item (default: item)",
          },
          "item-key": { type: "string", description: "Alias for itemKey" },
          "input-max-length": {
            type: "number",
            description:
              "Max length (chars) when auto-injecting stdin into args.input. " +
              "Stdin items beyond this are truncated and a one-line warning is " +
              "written to stderr. Default: 8000. Set 0 to disable truncation.",
          },
          "input-max": { type: "number", description: "Alias for input-max-length" },
          _: { type: "array", items: { type: "string" } },
        },
        required: ["tool", "action"],
      },
      sideEffects: ["calls_clawd_tool"],
    },
    help() {
      return (
        `${commandName} — call a local OpenClaw tool endpoint\n\n` +
        `Usage:\n` +
        `  ${commandName} --tool message --action send --args-json '{"provider":"telegram","to":"...","message":"..."}'\n` +
        `  ${commandName} --tool message --action send --args-json '{...}' --dry-run\n` +
        `  ... | ${commandName} --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'\n\n` +
        `Config:\n` +
        `  - Uses OPENCLAW_URL env var by default (or pass --url).\n` +
        `  - Backward compatible: CLAWD_URL is also supported.\n` +
        `  - Optional Bearer token via OPENCLAW_TOKEN env var (or pass --token).\n` +
        `  - Backward compatible: CLAWD_TOKEN is also supported.\n` +
        `  - Optional attribution via --session-key <sessionKey>.\n\n` +
        `Notes:\n` +
        `  - This is a thin transport bridge. Lobster should not own OAuth/secrets.\n`
      );
    },
    async run({ input, args, ctx }) {
      const each = Boolean(args.each);
      const itemKey = String(args.itemKey ?? args["item-key"] ?? "item");

      const url = String(args.url ?? ctx.env.OPENCLAW_URL ?? ctx.env.CLAWD_URL ?? "").trim();
      if (!url) throw new Error(`${commandName} requires --url or OPENCLAW_URL`);

      const tool = args.tool;
      const action = args.action;
      if (!tool || !action) throw new Error(`${commandName} requires --tool and --action`);

      const token = String(
        args.token ?? ctx.env.OPENCLAW_TOKEN ?? ctx.env.CLAWD_TOKEN ?? "",
      ).trim();

      let toolArgs: any = {};
      if (args["args-json"]) {
        try {
          toolArgs = JSON.parse(String(args["args-json"]));
        } catch (_err) {
          throw new Error(`${commandName} --args-json must be valid JSON`);
        }
      }

      if (each && (toolArgs === null || typeof toolArgs !== "object" || Array.isArray(toolArgs))) {
        throw new Error(`${commandName} --each requires --args-json to be an object`);
      }

      const endpoint = new URL("/tools/invoke", url);
      const sessionKey = args.sessionKey ?? args["session-key"] ?? null;
      const dryRun = args.dryRun ?? args["dry-run"] ?? null;

      const invokeOnce = async (argsValue: unknown) => {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : null),
          },
          body: JSON.stringify({
            tool: String(tool),
            action: String(action),
            args: argsValue,
            ...(sessionKey ? { sessionKey: String(sessionKey) } : null),
            ...(dryRun !== null ? { dryRun: Boolean(dryRun) } : null),
          }),
        });

        const text = await res.text();
        if (!res.ok) {
          throw new Error(`${commandName} failed (${res.status}): ${text.slice(0, 400)}`);
        }

        let parsed: any;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch (_err) {
          throw new Error(`${commandName} expected JSON response`);
        }

        // Preferred: { ok: true, result: ... }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "ok" in parsed) {
          if (parsed.ok !== true) {
            const msg = parsed?.error?.message ?? "Unknown error";
            throw new Error(`${commandName} tool error: ${msg}`);
          }
          const result = parsed.result;
          return Array.isArray(result) ? result : [result];
        }

        // Compatibility: raw JSON result
        return Array.isArray(parsed) ? parsed : [parsed];
      };

      if (!each) {
        // Drain stdin and auto-inject into args.input when the caller hasn't
        // explicitly set it. This makes `stdin: $prev.stdout` chain naturally
        // into the skill's input field — without it, OpenClaw's skill invoke
        // protocol (raw_input = args.input) silently loses upstream output.
        // Callers that want to pass explicit args without stdin still work:
        // empty stdin → drained.length === 0 → no injection.
        const drained: any[] = [];
        for await (const item of input) {
          drained.push(item);
        }
        const hasExplicitInput =
          toolArgs != null &&
          typeof toolArgs === "object" &&
          "input" in toolArgs &&
          toolArgs.input != null &&
          toolArgs.input !== "";
        if (drained.length > 0 && !hasExplicitInput) {
          if (toolArgs == null || typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
            toolArgs = {};
          }
          // Truncate when upstream stdout is very long — downstream skills
          // often have schema caps (e.g. baoyu-cover-image: topic ≤ 2000).
          // Default 8000 chars; --input-max-length 0 disables truncation.
          const maxLenRaw = args["input-max-length"] ?? args["input-max"];
          const maxLen =
            maxLenRaw === undefined ? 8000 : Math.max(0, Math.floor(Number(maxLenRaw) || 0));
          const singleItem = drained.length === 1;
          let injected: unknown = singleItem ? drained[0] : drained;
          if (maxLen > 0) {
            const asText =
              typeof injected === "string"
                ? injected
                : JSON.stringify(injected);
            if (typeof asText === "string" && asText.length > maxLen) {
              const truncated = asText.slice(0, maxLen) + "…[truncated]";
              process.stderr.write(
                `[${commandName}] stdin → args.input truncated from ${asText.length} to ${maxLen} chars\n`,
              );
              injected = truncated;
            }
          }
          toolArgs.input = injected;
        }
        const items = await invokeOnce(toolArgs);
        return { output: asStream(items) };
      }

      const out: any[] = [];
      for await (const item of input) {
        const argsValue = { ...(toolArgs as any), [itemKey]: item };
        const items = await invokeOnce(argsValue);
        out.push(...items);
      }

      return { output: asStream(out) };
    },
  };
}

async function* asStream(items: any[]) {
  for (const item of items) yield item;
}

export const openclawInvokeCommand = createInvokeCommand("openclaw.invoke");
export const clawdInvokeCommand = createInvokeCommand("clawd.invoke");
