import { RedactionScope } from "~/lib/redaction/context"
import { redactionConfigSchema } from "~/lib/redaction/rules"
import { restoreRedactionStream } from "~/lib/redaction/stream"

const scope = new RedactionScope(
  redactionConfigSchema.parse({ enabled: true, words: ["private-project"] }),
  "restart-caller",
)

if (process.argv[2] === "mask") {
  console.log(
    JSON.stringify(
      scope.mask({
        password: "restart-credential",
        text: "/home/restart-user/work private-project",
      }),
    ),
  )
} else {
  const input: { password: string; text: string } = JSON.parse(process.argv[3])
  const masked = scope.mask(input)
  async function* frames() {
    yield {
      data: JSON.stringify({
        type: "response.output_text.delta",
        delta: masked.text,
      }),
    }
  }
  const streamed = []
  for await (const frame of restoreRedactionStream(frames(), scope, "issuer"))
    streamed.push(JSON.parse((frame as { data: string }).data))
  console.log(
    JSON.stringify({
      masked,
      restored: scope.restore(masked, "issuer"),
      streamed,
      tool: scope.restore(
        {
          type: "function_call",
          arguments: JSON.stringify({ command: input.text }),
        },
        "issuer",
      ),
    }),
  )
}
