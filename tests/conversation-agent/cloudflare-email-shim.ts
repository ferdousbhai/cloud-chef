/** The Agents SDK imports `cloudflare:email` for email replies, which the ConversationAgent never sends. */
export class EmailMessage {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly raw: ReadableStream | string,
  ) {}
}
