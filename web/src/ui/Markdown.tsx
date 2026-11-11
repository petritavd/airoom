import { useMemo, useState } from 'react';

/**
 * Dependency-free markdown renderer for agent replies.
 *
 * Covers what Claude actually emits: headings, nested bullet/ordered lists,
 * blockquotes, tables, rules, fenced code (with language + copy), inline bold /
 * italic / code / strike / links / bare URLs. Deliberately small and total —
 * anything it doesn't understand renders as plain text rather than vanishing.
 */

const INLINE_RE =
  /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|~~[^~]+~~|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>()[\]]+)/g;

function Inline({ text, depth = 0 }: { text: string; depth?: number }) {
  if (depth > 4) return <>{text}</>;
  const parts = text.split(INLINE_RE).filter((p) => p !== undefined && p !== '');
  return (
    <>
      {parts.map((p, i) => {
        const key = i;
        if (p.length > 4 && ((p.startsWith('**') && p.endsWith('**')) || (p.startsWith('__') && p.endsWith('__'))))
          return (
            <strong key={key}>
              <Inline text={p.slice(2, -2)} depth={depth + 1} />
            </strong>
          );
        if (p.length > 2 && p.startsWith('`') && p.endsWith('`')) return <code key={key}>{p.slice(1, -1)}</code>;
        if (p.length > 4 && p.startsWith('~~') && p.endsWith('~~'))
          return (
            <s key={key}>
              <Inline text={p.slice(2, -2)} depth={depth + 1} />
            </s>
          );
        if (p.length > 2 && p.startsWith('*') && p.endsWith('*'))
          return (
            <em key={key}>
              <Inline text={p.slice(1, -1)} depth={depth + 1} />
            </em>
          );
        const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(p);
        if (link)
          return (
            <a key={key} href={link[2]} target="_blank" rel="noreferrer noopener">
              {link[1]}
            </a>
          );
        if (/^https?:\/\//.test(p))
          return (
            <a key={key} href={p} target="_blank" rel="noreferrer noopener">
              {p.replace(/^https?:\/\//, '')}
            </a>
          );
        return <span key={key}>{p}</span>;
      })}
    </>
  );
}

/**
 * The one preformatted surface in the chat — code fences, pasted terminal
 * output, error details, tool payloads.
 *
 * Wraps by DEFAULT so the common case never grows a horizontal scrollbar, with
 * an opt-in nowrap toggle for diffs and columnar output. Long blocks clamp to a
 * fixed height and say exactly how much is hidden: there is no gradient fade
 * (banned), and stating "show all 84 lines" beats blurring the edge anyway.
 */
export function Blk({
  code,
  lang,
  label,
  clampLines = 18,
}: {
  code: string;
  lang?: string;
  label?: string;
  clampLines?: number;
}) {
  const lines = useMemo(() => code.split('\n').length, [code]);
  const long = lines > clampLines;
  const [open, setOpen] = useState(!long);
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);

  return (
    <figure
      className="blk"
      data-wrap={wrap ? 'on' : 'off'}
      data-open={open ? 'true' : 'false'}
      style={{ ['--clamp' as string]: clampLines }}
    >
      <figcaption className="blk__bar">
        <span className="blk__lang">{label ?? lang ?? 'text'}</span>
        <span className="blk__n">
          {lines} {lines === 1 ? 'line' : 'lines'}
        </span>
        <span className="blk__gap" />
        <button className="blk__b" onClick={() => setWrap((w) => !w)} title="Toggle line wrapping">
          {wrap ? 'nowrap' : 'wrap'}
        </button>
        <button
          className="blk__b"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </figcaption>
      <pre className="blk__pre">
        <code>{code}</code>
      </pre>
      {long && (
        <button className="blk__more" onClick={() => setOpen((v) => !v)}>
          {open ? 'collapse' : `show all ${lines} lines`}
        </button>
      )}
    </figure>
  );
}

type Row = { text: string; indent: number };

/** Render a run of list items (already stripped of their markers). */
function List({ rows, ordered, start }: { rows: Row[]; ordered: boolean; start: number }) {
  // group by indent: deeper rows become a nested list under the previous item
  const out: { text: string; children: Row[] }[] = [];
  const base = rows.length ? Math.min(...rows.map((r) => r.indent)) : 0;
  for (const r of rows) {
    if (r.indent > base && out.length) out[out.length - 1].children.push({ ...r, indent: r.indent - 2 });
    else out.push({ text: r.text, children: [] });
  }
  const items = out.map((it, i) => (
    <li key={i}>
      <Inline text={it.text} />
      {it.children.length > 0 && <List rows={it.children} ordered={false} start={1} />}
    </li>
  ));
  return ordered ? <ol start={start}>{items}</ol> : <ul>{items}</ul>;
}

function Table({ rows }: { rows: string[] }) {
  const cells = (line: string) =>
    line
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells); // row 1 is the --- separator
  return (
    <div className="md__tablewrap">
      <table className="md__table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>
                <Inline text={h} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => (
                <td key={ci}>
                  <Inline text={c} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parse(text), [text]);
  return <div className="md">{blocks}</div>;
}

function parse(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    // fenced code
    const fence = /^```(.*)$/.exec(t);
    if (fence) {
      const lang = fence[1].trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) buf.push(lines[i++]);
      i++; // closing fence (or EOF — unterminated fences still render)
      out.push(<Blk key={key++} code={buf.join('\n').replace(/\s+$/, '')} lang={lang || undefined} />);
      continue;
    }

    if (!t) {
      i++;
      continue;
    }

    // horizontal rule
    if (/^([-*_])\1{2,}$/.test(t)) {
      out.push(<hr key={key++} />);
      i++;
      continue;
    }

    // heading
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      const level = Math.min(4, h[1].length);
      out.push(
        <p key={key++} className={`md__h md__h${level}`}>
          <Inline text={h[2]} />
        </p>,
      );
      i++;
      continue;
    }

    // table (header row + separator row)
    if (/^\|.*\|/.test(t) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const rows: string[] = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) rows.push(lines[i++]);
      out.push(<Table key={key++} rows={rows} />);
      continue;
    }

    // blockquote
    if (/^>\s?/.test(t)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(
        <blockquote key={key++}>
          {parse(buf.join('\n'))}
        </blockquote>,
      );
      continue;
    }

    // lists (a run of consecutive bullet/ordered rows, indent-aware)
    const isBullet = (s: string) => /^\s*[-*•]\s+/.test(s);
    const isOrdered = (s: string) => /^\s*\d+[.)]\s+/.test(s);
    if (isBullet(line) || isOrdered(line)) {
      const ordered = isOrdered(line);
      const start = ordered ? parseInt(/^\s*(\d+)/.exec(line)![1], 10) || 1 : 1;
      const rows: Row[] = [];
      while (i < lines.length && (isBullet(lines[i]) || isOrdered(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        const raw = lines[i];
        const indent = raw.length - raw.trimStart().length;
        if (isBullet(raw) || isOrdered(raw)) {
          rows.push({ indent, text: raw.trim().replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '') });
        } else if (rows.length) {
          rows[rows.length - 1].text += ` ${raw.trim()}`; // continuation line
        }
        i++;
      }
      out.push(<List key={key++} rows={rows} ordered={ordered} start={start} />);
      continue;
    }

    // paragraph — consume until a blank line or a block starter
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i].trim()) &&
      !/^#{1,4}\s/.test(lines[i].trim()) &&
      !/^>\s?/.test(lines[i].trim()) &&
      !isBullet(lines[i]) &&
      !isOrdered(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length)
      out.push(
        <p key={key++}>
          <Inline text={para.join(' ')} />
        </p>,
      );
  }
  return out;
}
