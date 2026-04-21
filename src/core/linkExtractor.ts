/**
 * 从 Notion block 列表中抽取「链接关系」。
 *
 * 支持的来源：
 *   1. child_page / child_database —— 父子嵌套关系
 *   2. link_to_page 类型的整块 —— 显式页面引用
 *   3. 富文本中的 mention（type = page/database）—— @提及
 *   4. 富文本中的 text.link.url 指向 notion.so 的超链接
 *
 * 返回结构保持对边类型的区分：parent-child 与 link-to-page。
 */

import type { NotionBlock } from './notionClient';
import { isNotionId, parseIdFromUrl, toCompactId } from './idUtils';
import type { EdgeKind, NotionObjectType } from './types';

export interface ExtractedRef {
  /** 目标对象 id（紧凑 hex） */
  id: string;
  /** 猜测的对象类型；无法判定时默认 page */
  type: NotionObjectType;
  /** 这条引用的边类型 */
  kind: EdgeKind;
}

/** 块里的富文本条目，覆盖了 mention 与 text 两种 */
interface RichTextItem {
  type?: string;
  text?: { content?: string; link?: { url?: string } | null };
  mention?: {
    type?: string;
    page?: { id?: string };
    database?: { id?: string };
  };
}

/** 带 rich_text 字段的块类型集合 */
const RICH_TEXT_BLOCK_TYPES = new Set([
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'toggle',
  'quote',
  'callout',
  'to_do',
  'template',
]);

/**
 * 从一组 block 中抽取所有引用。
 *
 * @param blocks 来自 listAllBlockChildren 的结果
 * @param options 过滤开关
 */
export function extractRefs(
  blocks: NotionBlock[],
  options: { includeParentChild: boolean; includeLinkToPage: boolean },
): ExtractedRef[] {
  const out: ExtractedRef[] = [];
  const seen = new Set<string>();

  const push = (ref: ExtractedRef) => {
    const key = `${ref.id}:${ref.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };

  for (const b of blocks) {
    if (!b?.type) continue;

    if (options.includeParentChild) {
      if (b.type === 'child_page') {
        push({ id: toCompactId(b.id), type: 'page', kind: 'parent-child' });
        continue;
      }
      if (b.type === 'child_database') {
        push({ id: toCompactId(b.id), type: 'database', kind: 'parent-child' });
        continue;
      }
    }

    if (!options.includeLinkToPage) continue;

    if (b.type === 'link_to_page') {
      const l = b.link_to_page as
        | { type?: 'page_id' | 'database_id'; page_id?: string; database_id?: string }
        | undefined;
      if (l?.type === 'page_id' && l.page_id) {
        push({ id: toCompactId(l.page_id), type: 'page', kind: 'link-to-page' });
      } else if (l?.type === 'database_id' && l.database_id) {
        push({ id: toCompactId(l.database_id), type: 'database', kind: 'link-to-page' });
      }
      continue;
    }

    // 富文本块：读 rich_text 数组
    if (RICH_TEXT_BLOCK_TYPES.has(b.type)) {
      const payload = b[b.type] as { rich_text?: RichTextItem[] } | undefined;
      for (const rt of payload?.rich_text ?? []) {
        collectFromRichText(rt, push);
      }
    }
  }

  return out;
}

function collectFromRichText(rt: RichTextItem, push: (ref: ExtractedRef) => void): void {
  // 1) mention
  if (rt.type === 'mention' && rt.mention) {
    if (rt.mention.type === 'page' && rt.mention.page?.id) {
      push({ id: toCompactId(rt.mention.page.id), type: 'page', kind: 'link-to-page' });
    } else if (rt.mention.type === 'database' && rt.mention.database?.id) {
      push({ id: toCompactId(rt.mention.database.id), type: 'database', kind: 'link-to-page' });
    }
    return;
  }

  // 2) text.link.url
  const url = rt.text?.link?.url;
  if (!url) return;

  // 相对链接：形如 "/1a2b3c4d..."，指向工作区内页面
  if (url.startsWith('/')) {
    const m = url.match(/([0-9a-f]{32})/i);
    if (m) {
      push({ id: m[1].toLowerCase(), type: 'page', kind: 'link-to-page' });
    }
    return;
  }

  if (url.includes('notion.so') || url.includes('notion.site')) {
    const id = parseIdFromUrl(url);
    if (id && isNotionId(id)) {
      push({ id: toCompactId(id), type: 'page', kind: 'link-to-page' });
    }
  }
}
