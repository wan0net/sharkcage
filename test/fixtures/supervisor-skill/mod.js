let input = "";
for await (const chunk of process.stdin) {
  input += chunk.toString();
}

const request = JSON.parse(input);

if (request.tool === "echo") {
  process.stdout.write(JSON.stringify({
    tool: request.tool,
    args: request.args,
    envFlag: process.env.SHARKCAGE_TOOL_CALL ?? null,
  }));
  process.exit(0);
}

if (request.tool === "violate_network") {
  process.stderr.write("ENOTFOUND blocked.example.com");
  process.exit(1);
}

process.stderr.write(`Unknown tool: ${request.tool}`);
process.exit(1);
