// Niko speaks its answers, so they should be plain sentences. Models still slip into Markdown (**bold**, lists, `code`)
// and symbols that a voice reads out loud ("asterisk asterisk"). plainText() cleans an answer for showing (the [[…]]
// tags the app acts on are left alone); speakable() goes further for the voice only.

const TAG = /(\[\[[^\]]*\]\])/;

function clean(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-z]*\n?/gi, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*(?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/(^|[\s(])_(?=\S)([^_\n]*?\S)_(?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*•+]\s+/gm, '')
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    .replace(/\*{2,}|_{2,}/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}
/** An answer without Markdown, for the screen and for history. Tags such as [[map:…]] are kept as they are. */
export function plainText(text: string): string {
  return text.split(TAG).map((part) => (TAG.test(part) ? part : clean(part))).join('').trim();
}

/** Text with none of the app's [[…]] tags left in it: for a draft or a message (which is never acted on), and for
 * whatever the app shows after taking the tags it knows. A tag the app doesn't act on is never shown either. */
export function stripTags(text: string): string {
  return text.replace(/[ \t]*\[\[[^\]\n]*\]\][ \t]*/g, (m) => (/^\s|\s$/.test(m) ? ' ' : '')).replace(/ +([.,!?;:])/g, '$1').replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').trim();
}

/** What the voice says: no symbols read out as words ("asterisk", "slash", "hash"), and ranges and units said
 * the way a person would ("23 to 30 degrees"). */
export function speakable(text: string): string {
  return plainText(text).replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/(\d)\s*°\s*([CF])\b/g, '$1 degrees')
    .replace(/(\d)\s*°/g, '$1 degrees')
    .replace(/(\d)\s*[–—-]\s*(\d)/g, '$1 to $2')
    .replace(/(\d)\s*%/g, '$1 percent')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s&\s/g, ' and ')
    .replace(/(\w)\s*\/\s*(\w)/g, (m, a, b) => (/\d/.test(a) && /\d/.test(b) ? m : `${a} or ${b}`))
    .replace(/[*#_~`|<>{}\[\]^=\\]+/g, ' ')
    .replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu, '')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
