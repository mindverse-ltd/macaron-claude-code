export function anthropicMessagesUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/messages`;
}
