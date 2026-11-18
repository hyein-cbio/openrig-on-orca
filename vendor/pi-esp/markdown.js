import { Marked } from 'marked';
const MAX_TABLE_CELLS = 1024;
const markdown = new Marked({ gfm: true, tokenizer: {
    table(source) {
        // Use the pinned Marked grammar before its default tokenizer pads and tokenizes cells.
        const match = this.rules.block.table.exec(source);
        if (!match || !this.rules.other.tableDelimiter.test(match[2])) return false;
        const rules = this.rules.other, width = match[2].replace(rules.tableAlignChars, '').split('|').length;
        const header = match[1].replace(rules.findPipe, (_, offset, value) => {
            let escaped = false;
            for (let i = offset - 1; i >= 0 && value[i] === '\\'; i--) escaped = !escaped;
            return escaped ? '|' : ' |';
        }).split(rules.splitPipe);
        if (!header[0].trim()) header.shift();
        if (header.length && !header.at(-1).trim()) header.pop();
        if (header.length !== width) return false;
        const rows = match[3]?.trim() ? match[3].replace(this.rules.other.tableRowBlankLine, '').split('\n').length : 0;
        return width * (rows + 1) > MAX_TABLE_CELLS ? { type: 'table-omitted', raw: match[0] } : false;
    }
} });
/** Construct DOM from parsed Markdown. Never insert HTML, hrefs, images or user attributes. */
export function appendMarkdown(parent, source) {
    const doc = parent.ownerDocument;
    function element(into, name) {
        const child = doc.createElement(name);
        into.appendChild(child);
        return child;
    }
    const plain = (into, value) => { into.appendChild(doc.createTextNode(value)); };
    let entityDecoder;
    const prose = value => value.replace(/&(?:#[xX][\da-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z\d]*);/g, reference => {
        // Attribute parsing rejects ambiguous named prefixes. The regex admits only
        // a reference, never a quote, element or free-form transcript markup.
        entityDecoder ??= doc.createElement('template');
        entityDecoder.innerHTML = `<span data-entity="${reference}"></span>`;
        return entityDecoder.content.firstElementChild.getAttribute('data-entity') ?? reference;
    });
    function description(tokens) {
        return tokens.map(token => {
            if (token.type === 'escape' || token.type === 'codespan') return token.text ?? '';
            if (token.type === 'br') return ' ';
            if (token.tokens?.length) return description(token.tokens);
            return prose(token.text ?? token.raw ?? '');
        }).join('');
    }
    function children(into, token) {
        if (token.tokens?.length)
            render(into, token.tokens);
        else
            plain(into, token.text ?? token.raw ?? '');
    }
    function render(into, tokens) {
        for (const token of tokens) {
            switch (token.type) {
                case 'paragraph':
                    children(element(into, 'p'), token);
                    break;
                case 'heading':
                    children(element(into, `h${Math.min(6, Math.max(1, token.depth ?? 2))}`), token);
                    break;
                case 'text':
                    if (token.tokens?.length)
                        render(into, token.tokens);
                    else
                        plain(into, prose(token.text ?? token.raw ?? ''));
                    break;
                case 'escape':
                case 'link':
                    children(into, token);
                    break;
                case 'strong':
                case 'em':
                case 'del':
                case 'blockquote':
                    children(element(into, token.type), token);
                    break;
                case 'image': {
                    const label = token.tokens?.length ? description(token.tokens) : prose(token.text ?? '');
                    plain(into, label ? `[Image omitted: ${label}]` : '[Image omitted]');
                    break;
                }
                case 'code':
                    plain(element(element(into, 'pre'), 'code'), token.text ?? '');
                    break;
                case 'codespan':
                    plain(element(into, 'code'), token.text ?? '');
                    break;
                case 'br':
                case 'hr':
                    element(into, token.type);
                    break;
                case 'list': {
                    const list = element(into, token.ordered ? 'ol' : 'ul');
                    if (token.ordered && Number.isSafeInteger(token.start))
                        list.setAttribute('start', String(token.start));
                    for (const item of token.items ?? []) {
                        const li = element(list, 'li');
                        let prefix = item.task ? item.checked ? '[Completed] ' : '[Pending] ' : '';
                        if (token.loose && item.tokens?.length) {
                            for (const part of item.tokens) {
                                if (part.type === 'space') continue;
                                const host = part.type === 'text' || part.type === 'paragraph' ? element(li, 'p') : li;
                                if (prefix) { plain(host, prefix); prefix = ''; }
                                if (part.type === 'paragraph') children(host, part);
                                else render(host, [part]);
                            }
                            if (prefix) plain(li, prefix);
                        }
                        else {
                            if (prefix) plain(li, prefix);
                            children(li, item);
                        }
                    }
                    break;
                }
                case 'table-omitted':
                    plain(element(into, 'pre'), token.raw ?? '');
                    break;
                case 'table': {
                    const width = token.header?.length ?? 0, rows = token.rows?.length ?? 0;
                    if (width * (rows + 1) > MAX_TABLE_CELLS) {
                        plain(element(into, 'pre'), token.raw ?? '');
                        break;
                    }
                    const table = element(element(into, 'div'), 'table');
                    table.parentElement?.classList.add('pi-esp-table');
                    const head = element(element(table, 'thead'), 'tr');
                    const cell = (row, tag, content, index) => {
                        const host = element(row, tag), alignment = token.align?.[index];
                        if (['left', 'center', 'right'].includes(alignment)) host.classList.add(`pi-esp-align-${alignment}`);
                        children(host, content);
                    };
                    for (const [index, content] of (token.header ?? []).entries())
                        cell(head, 'th', content, index);
                    const body = element(table, 'tbody');
                    for (const cells of token.rows ?? []) {
                        const row = element(body, 'tr');
                        for (const [index, content] of cells.entries())
                            cell(row, 'td', content, index);
                    }
                    break;
                }
                case 'def':
                case 'space': break;
                default: plain(into, token.raw ?? token.text ?? '');
            }
        }
    }
    try {
        render(parent, markdown.lexer(source));
    }
    catch {
        parent.textContent = source;
    }
}
