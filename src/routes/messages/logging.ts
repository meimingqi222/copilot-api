export function isMessagesOutputEvent(event: { type?: string }): boolean {
  return (
    event.type === "content_block_start" || event.type === "content_block_delta"
  )
}
