// Only explicit mentions in the current user input select native skills.
// Code examples, shell variables and mentions in inherited history are not inputs.
export function skillMentions(text) {
  const prose = String(text || '').replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*(?:`|$)/g, ' ');
  return new Set([...prose.matchAll(/(?:^|[\s(])\$([\p{L}\p{N}_:-]+)(?=$|[\s.,!?;:)])/gu)].map(match => match[1]));
}
