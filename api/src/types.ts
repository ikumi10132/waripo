// API と画面で共有する型

export interface Member {
  /** W-SSO の sub */
  sub: string;
  email: string;
}

/** 割り勘をする 2 人 */
export interface Pair {
  id: string;
  members: Member[];
  createdAt: string;
}

/**
 * 記録の種類。どれも「お金が from から to へ流れた (= to が from に借りた)」として残高を計算する
 * - split: 割り勘。払った人 (from) が、相手の負担分を立て替えた
 * - settle: 精算。借りていた人 (from) が、貸していた人 (to) に返した
 * - initial: 最初の残高 (Warica などから引き継ぐ)。貸している人 (from) と借りている人 (to)
 */
export type EntryType = 'split' | 'settle' | 'initial';

export interface Entry {
  /** "YYYY-MM-DD_xxxx" */
  id: string;
  type: EntryType;
  date: string;
  title: string;
  memo: string;
  /** split: 払った人。settle: 返した人。initial: 貸している人 */
  from: string;
  /** split: 立て替えてもらった人。settle: 受け取った人。initial: 借りている人 */
  to: string;
  /** split: 支払いの合計。settle/initial: 金額 */
  amount: number;
  /** split のときの、立て替えてもらった人 (to) の負担額。払った人の負担は amount - share */
  share?: number;
  /** 家計簿と連動しているとき */
  kakeibo?: {
    /** 払った人の家計簿の明細 id */
    payerTxId?: string;
    /** 払った人の明細を waripo が作ったか (削除するときに明細ごと消すかどうか) */
    payerCreated?: boolean;
    /** 立て替えてもらった人の家計簿に作った明細 id */
    otherTxId?: string;
  };
  createdBy: string;
  createdAt: string;
}

export interface Summary {
  me: Member;
  pair: Pair | null;
  /** 相手 (2 人なので 1 人) */
  partner: Member | null;
  /** 正なら相手が自分に借りている、負なら自分が相手に借りている (円) */
  balance: number;
  entries: Entry[];
}

/** 家計簿の明細に付ける割り勘の情報 (kakeibo の Transaction.split と同じ形) */
export interface KakeiboSplit {
  entryId: string;
  /** payer: 自分が払って相手の分を立て替えた。partner: 相手が払った分のうち自分の負担 */
  role: 'payer' | 'partner';
  /** payer のときの相手の負担額。自分の負担 = 明細の金額 - otherShare */
  otherShare?: number;
}
