import * as db from './db.js';
import type { KakeiboCategory } from './db.js';

const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase();

/**
 * 払った人の明細のカテゴリーに当たる、相手の家計簿のカテゴリー id を決める。
 * 1) 同じ id のカテゴリー 2) 同じ種類・同じ親・同じ名前のカテゴリー 3) どちらもなければ相手の家計簿に作る (親カテゴリーも同様)。
 * 作るのは割り勘にした時点のコピーだけで、あとでどちらかがカテゴリーを変えても相手には反映しない
 */
export async function partnerCategoryId(payer: string, partner: string, categoryId: string | null): Promise<string | null> {
  if (!categoryId) return null;
  const src = await db.getKakeiboCategory(payer, categoryId);
  if (!src) return null;
  const srcParent = src.parentId ? await db.getKakeiboCategory(payer, src.parentId) : undefined;

  const theirs = await db.listKakeiboCategories(partner);
  let order = Math.max(0, ...theirs.map((c) => c.order ?? 0)) + 1;

  const ensure = async (c: KakeiboCategory, parentId: string | null): Promise<string> => {
    const hit =
      theirs.find((t) => t.id === c.id && t.type === c.type) ??
      theirs.find((t) => t.type === c.type && (t.parentId ?? null) === parentId && norm(t.name) === norm(c.name));
    if (hit) return hit.id;
    // 同じ id で作る (次に同じカテゴリーで割り勘にしたとき、id で見つかる)
    const id = theirs.some((t) => t.id === c.id) ? `${c.id}-${db.shortId().slice(0, 4)}` : c.id;
    const created: KakeiboCategory = { id, name: c.name, type: c.type, parentId, icon: c.icon, color: c.color, order: order++ };
    await db.putKakeiboCategory(partner, created);
    theirs.push(created);
    return id;
  };

  const parentId = srcParent ? await ensure(srcParent, null) : null;
  return ensure(src, parentId);
}
