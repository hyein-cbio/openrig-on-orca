import { appendMarkdown } from './markdown.js';
const mountedViews = new WeakMap();
const MAX_VISIBLE = 160;
const MAX_RUN = 24;
const MAX_SEEN = 1024;
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const nameOf = (name) => name.toLowerCase().replace(/^functions?\./, '');
const labels = Object.freeze({
    read: ['Read', 'read', 'reads'], edit: ['Edit', 'edit', 'edits'], write: ['Write', 'write', 'writes'],
    bash: ['Run', 'command', 'commands'], grep: ['Search', 'search', 'searches'], find: ['Find', 'search', 'searches'], ls: ['List', 'listing', 'listings']
});
const toolLabel = (name) => Object.hasOwn(labels, nameOf(name)) ? labels[nameOf(name)] : ['Tool', 'tool call', 'tool calls'];
const singleLine = (value) => value.replace(/\s+/g, ' ').trim();
const settledLabels = Object.freeze({
    read: ['Read', 'file', 'files'], edit: ['Edited', 'file', 'files'], write: ['Wrote', 'file', 'files'], bash: ['Ran', 'command', 'commands']
});
/** Mount an Orca-inspired, read-only transcript. The caller owns data and polling. */
export function mountTranscript(root) {
    mountedViews.get(root)?.();
    const doc = root.ownerDocument;
    const node = (tag, cls, text) => {
        const element = doc.createElement(tag);
        if (cls)
            element.className = cls;
        if (text)
            element.textContent = text;
        return element;
    };
    root.classList.add('pi-esp-transcript');
    const scroll = node('div', 'pi-esp-scroll'), feed = node('div', 'pi-esp-feed');
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', 'Pi transcript');
    scroll.tabIndex = 0;
    const jump = node('button', 'pi-esp-jump', '↓ Jump to latest');
    jump.type = 'button';
    jump.hidden = true;
    scroll.append(feed);
    root.replaceChildren(scroll, jump);
    const units = [], pending = new Map(), seen = new Set();
    let active, visible = 0, unseen = 0, pendingFollow = false, lastFollow = true;
    let lastHeight = 0, lastContent = 0;
    function readPosition() {
        const height = scroll.clientHeight, content = scroll.scrollHeight, top = scroll.scrollTop;
        if (!height) return;
        const end = content - height - top <= 22;
        // A queued scroll event after layout clamping must not turn off follow
        // just because new content reflowed before ResizeObserver runs.
        if (end || !lastFollow || height === lastHeight && content === lastContent) {
            lastFollow = end; lastHeight = height; lastContent = content;
        }
    }
    function updateJump() {
        if (lastFollow) {
            unseen = 0;
            if (doc.activeElement === jump) scroll.focus({ preventScroll: true });
        }
        jump.hidden = lastFollow;
        jump.textContent = unseen ? `↓ ${plural(unseen, 'update')} · Jump to latest` : '↓ Jump to latest';
    }
    function jumpToLatest() {
        if (disposed) return;
        lastFollow = true;
        pendingFollow = scroll.clientHeight === 0;
        if (!pendingFollow) {
            scroll.scrollTop = scroll.scrollHeight;
            lastHeight = scroll.clientHeight; lastContent = scroll.scrollHeight;
        }
        updateJump();
    }
    const scrollMoved = () => { readPosition(); updateJump(); };
    let disposed = false;
    scroll.addEventListener('scroll', scrollMoved, { passive: true });
    jump.addEventListener('click', jumpToLatest);
    const Resize = doc.defaultView?.ResizeObserver;
    const resize = Resize ? new Resize(() => {
        if (disposed) return;
        if ((pendingFollow || lastFollow) && scroll.clientHeight > 0) jumpToLatest();
        else scrollMoved();
    }) : null;
    resize?.observe(scroll); resize?.observe(feed);
    mountedViews.set(root, dispose);
    function host(unit) { units.push(unit); feed.append(unit.node); visible++; }
    function mark(element) { element.dataset.espAnchor = ''; return element; }
    function updateRun(run) {
        const counts = new Map();
        for (const { name } of run.tools) {
            const [, one, many] = toolLabel(name);
            const item = counts.get(one) ?? { one, many, count: 0 };
            item.count++;
            counts.set(one, item);
        }
        const failures = run.tools.filter(tool => tool.result === 'failed').length;
        const done = run.tools.every(tool => tool.result === 'recorded');
        const name = nameOf(run.tools[0].name), wording = Object.hasOwn(settledLabels, name) ? settledLabels[name] : undefined;
        run.label.textContent = done && wording && run.tools.every(tool => nameOf(tool.name) === name)
            ? `${wording[0]} ${plural(run.tools.length, wording[1], wording[2])}`
            : Array.from(counts.values(), group => plural(group.count, group.one, group.many)).join(' · ') + (failures ? ` · ${failures} failed` : '');
        run.check.hidden = !done;
        run.root.classList.toggle('pi-esp-run-failed', failures > 0);
    }
    function activityIcon(name) {
        const ns = 'http://www.w3.org/2000/svg', icon = doc.createElementNS(ns, 'svg'), path = doc.createElementNS(ns, 'path');
        const tool = nameOf(name);
        icon.setAttribute('viewBox', '0 0 16 16');
        icon.setAttribute('class', 'pi-esp-activity-icon');
        icon.setAttribute('aria-hidden', 'true');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-linecap', 'round');
        icon.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('d', tool === 'read' ? 'M4 2.5h6l2 2v9H4zM6 7.5h4M6 10h4' : tool === 'edit' || tool === 'write' ? 'm3 13 1-4 7-7 3 3-7 7zM9 4l3 3' : 'm3 4 4 4-4 4m6 0h4');
        icon.append(path);
        return icon;
    }
    function toolRun(name) {
        if (active && active.tools.length < MAX_RUN) {
            visible++;
            return active;
        }
        const details = node('details', 'pi-esp-run'), summary = mark(node('summary', 'pi-esp-activity'));
        const label = node('span'), list = node('div', 'pi-esp-tool-list'), check = node('span', 'pi-esp-activity-check', '✓');
        check.setAttribute('aria-hidden', 'true');
        check.hidden = true;
        summary.append(activityIcon(name), label, check);
        details.append(summary, list);
        active = { root: details, label, check, list, tools: [] };
        host({ node: details, run: active });
        return active;
    }
    function formattedOutput(result) {
        const output = node('pre', 'pi-esp-output');
        if (!result.diff) {
            output.textContent = result.output || 'No text output recorded.';
            return output;
        }
        output.setAttribute('aria-label', 'Recorded diff');
        for (const [index, line] of result.diff.split('\n').entries()) {
            if (index)
                output.append('\n');
            const color = line.startsWith('+++') || line.startsWith('---') ? '' : line.startsWith('+') ? 'pi-esp-added' : line.startsWith('-') ? 'pi-esp-removed' : '';
            output.append(node('span', color, line));
        }
        if (result.output) output.append('\n\n', result.output);
        return output;
    }
    function addTool(name, target, id, result) {
        const run = toolRun(name), detail = node('details', 'pi-esp-tool'), summary = mark(node('summary', 'pi-esp-tool-line'));
        const state = node('span', 'pi-esp-tool-state', 'Result not recorded'), body = mark(node('div', 'pi-esp-tool-detail'));
        const verb = toolLabel(name)[0];
        const primary = node('span', 'pi-esp-tool-name', verb === 'Tool' ? singleLine(name) : verb);
        const label = node('span', 'pi-esp-tool-target', singleLine(target));
        summary.append(primary, label, state);
        detail.append(summary, body);
        run.list.append(detail);
        let current = result;
        let rendered;
        const paint = () => {
            if (!detail.open || rendered && rendered === current)
                return;
            rendered = current;
            const pieces = [node('div', 'pi-esp-tool-full-name', name)];
            if (target) pieces.push(node('pre', 'pi-esp-output', target));
            if (current)
                pieces.push(formattedOutput(current));
            else if (!target)
                pieces.push(node('pre', 'pi-esp-output', 'Result not recorded.'));
            body.replaceChildren(...pieces);
        };
        detail.addEventListener('toggle', paint);
        const tool = { name, id, result: 'pending', setResult(next) {
                current = next;
                tool.result = next.failed ? 'failed' : 'recorded';
                state.textContent = next.failed ? 'Failed' : 'Recorded';
                state.classList.toggle('pi-esp-failure', next.failed);
                updateRun(run);
                paint();
            } };
        run.tools.push(tool);
        if (result)
            tool.setResult(result);
        else {
            if (id)
                pending.set(id, tool);
            updateRun(run);
        }
    }
    function row(event) {
        if (event.kind === 'tool-call') {
            addTool(event.name, event.target, event.callId);
            return;
        }
        if (event.kind === 'tool-result') {
            const tool = event.callId ? pending.get(event.callId) : undefined;
            if (tool) {
                tool.setResult(event);
                pending.delete(event.callId);
            }
            else
                addTool(event.name, '', undefined, event);
            return;
        }
        if (event.kind === 'shell') {
            addTool('bash', event.command, undefined, event);
            return;
        }
        active = undefined;
        const unit = mark(node('div', `pi-esp-row pi-esp-${event.kind}`));
        if (event.kind === 'user')
            unit.append(node('div', 'pi-esp-user-bubble', event.text));
        else if (event.kind === 'assistant')
            appendMarkdown(unit, event.text);
        else if (event.kind === 'thinking') {
            const details = node('details'), summary = node('summary', 'pi-esp-activity', 'Thinking');
            const body = node('div', 'pi-esp-thinking-body');
            details.addEventListener('toggle', () => { if (details.open && !body.hasChildNodes())
                appendMarkdown(body, event.text); });
            details.append(summary, body);
            unit.append(details);
        }
        else
            unit.textContent = event.text;
        if (event.at)
            unit.setAttribute('title', event.at);
        host({ node: unit });
    }
    function trim() {
        while (visible > MAX_VISIBLE) {
            const first = units.shift();
            visible -= first.run?.tools.length ?? 1;
            if (first.run)
                for (const tool of first.run.tools) {
                    if (tool.id && pending.get(tool.id) === tool)
                        pending.delete(tool.id);
                }
            if (first.node.contains(doc.activeElement))
                scroll.focus({ preventScroll: true });
            first.node.remove();
        }
        while (seen.size > MAX_SEEN)
            seen.delete(seen.values().next().value);
    }
    function append(events) {
        if (disposed) return;
        if (!events.length)
            return;
        readPosition();
        const follow = pendingFollow || lastFollow, { top, bottom } = scroll.getBoundingClientRect();
        // Keep fallback anchors when the first visible row ages out of the window.
        const anchors = follow ? [] : Array.from(feed.querySelectorAll('[data-esp-anchor]')).flatMap(item => {
            const rect = item.getBoundingClientRect();
            return rect.height > 0 && rect.bottom > top && rect.top < bottom && item.getClientRects().length ? [{ item, relative: rect.top - top }] : [];
        });
        let changes = 0;
        for (const event of events) {
            if (seen.has(event.key))
                continue;
            seen.add(event.key);
            row(event);
            trim();
            changes++;
        }
        if (follow)
            jumpToLatest();
        else {
            const anchor = anchors.find(({ item }) => feed.contains(item));
            if (anchor)
                scroll.scrollTop += anchor.item.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.relative;
            else if (anchors.length)
                scroll.scrollTop = 0; // All previously visible rows were evicted.
            unseen += changes;
            scrollMoved();
        }
    }
    function clear() {
        if (disposed) return;
        active = undefined;
        visible = 0;
        unseen = 0;
        seen.clear();
        pending.clear();
        units.length = 0; pendingFollow = false; lastFollow = true;
        if (feed.contains(doc.activeElement)) scroll.focus({ preventScroll: true });
        feed.replaceChildren();
        scroll.scrollTop = 0;
        updateJump();
    }
    function dispose() {
        disposed = true; resize?.disconnect();
        scroll.removeEventListener('scroll', scrollMoved);
        jump.removeEventListener('click', jumpToLatest);
        if (mountedViews.get(root) === dispose) mountedViews.delete(root);
    }
    return { append, clear, jumpToLatest, dispose };
}
