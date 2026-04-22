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
export const RICH_TEXT_BLOCK_TYPES = new Set([
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

/**
 * 将一个 Notion block 瘦身成「仅保留 extractRefs + BFS 下钻所需字段」的最小对象。
 *
 * 典型一个 paragraph block 的 Notion API 原始响应包含 `annotations`、`created_by`、
 * `parent`、富文本里的 `href`、样式等近 20 个字段，序列化后可达 1~2 KB；
 * 对于大型页面（数百个块）缓存很容易突破 `chrome.storage.local` 的配额上限。
 *
 * 这里做一次精确瘦身：
 *   - 永远保留：object / id / type / has_children
 *     （前两项为自识别必备，has_children 决定 BFS 是否继续下钻，type 决定 extractRefs 分支）
 *   - `link_to_page` 块：保留整个 `link_to_page` 子字段
 *   - 富文本块：保留 `[type].rich_text`，并对每个 item 只留 type/mention/text.link
 *     （因为 extractRefs 只关心 mention 与超链接 URL）
 *
 * 瘦身后体积通常只有原始的 1/5 ~ 1/10，对功能无任何影响。
 */
export function slimBlockForRefs(b: NotionBlock): NotionBlock {
  const slim: NotionBlock = {
    object: b.object,
    id: b.id,
    type: b.type,
    has_children: b.has_children,
  };

  if (b.type === 'link_to_page') {
    slim.link_to_page = b.link_to_page;
    return slim;
  }

  if (RICH_TEXT_BLOCK_TYPES.has(b.type)) {
    const payload = b[b.type] as { rich_text?: RichTextItem[] } | undefined;
    const items = payload?.rich_text ?? [];
    slim[b.type] = {
      rich_text: items.map(slimRichTextItem),
    };
  }

  return slim;
}

/** 富文本条目瘦身：只留 type / mention / text.link（去掉 annotations/plain_text/href 等） */
function slimRichTextItem(rt: RichTextItem): RichTextItem {
  const out: RichTextItem = { type: rt.type };
  if (rt.mention) out.mention = rt.mention;
  if (rt.text?.link) out.text = { link: rt.text.link };
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
