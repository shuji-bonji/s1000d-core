/**
 * 自作の入力データ（指定席券売機）。S1000D の公式サンプルの複製ではない。
 * 説明・手順・画面遷移・故障探求の 4 種のデータモジュールと PM、それに箇条書きと用語の説明を加えた説明 1 件。
 * `write/*.test.ts` が、組み立て・往復・XSD・BREX の検証に使う。
 */
import type { Allocation, DraftDataModule } from '../write/types.js';

/** 採番の規則。情報コードの値はこのプロジェクトの試作用で、意味を持たせていない */
export const kenbaikiAllocation = (): Allocation => ({
  modelIdentCode: 'KENBAIKI',
  systemDiffCode: 'A',
  rules: {
    sns: { systemCode: '10', subSystemCode: '2', subSubSystemCode: '0', assyCode: '00' },
    infoCodeByKind: {
      descript: { infoCode: '040', infoCodeVariant: 'A' },
      proced: { infoCode: '520', infoCodeVariant: 'A' },
      process: { infoCode: '130', infoCodeVariant: 'A' },
      fault: { infoCode: '411', infoCodeVariant: 'A' },
    },
    itemLocationCode: 'D',
  },
  icn: { cageCode: 'K0001', next: 1 },
});

/** `kenbaikiAllocation()` で各 sourceId に付く DMC（情報コードが違うので、分解コードはどれも 00） */
export const KENBAIKI_DMC = {
  descript: 'KENBAIKI-A-10-20-00-00A-040A-D',
  proced: 'KENBAIKI-A-10-20-00-00A-520A-D',
  process: 'KENBAIKI-A-10-20-00-00A-130A-D',
  fault: 'KENBAIKI-A-10-20-00-00A-411A-D',
} as const;

const common = {
  language: { languageIsoCode: 'ja', countryIsoCode: 'JP' },
  securityClassification: '01',
  responsiblePartnerCompany: 'K0001',
  originator: 'K0001',
  applic: { displayText: 'タッチパネル式、2 号機以降' },
  issueDate: '2026-10-28',
} as const;

export const descriptDraft = (): DraftDataModule => ({
  ...common,
  sourceId: 'topic-overview',
  kind: 'descript',
  title: { techName: '指定席券売機', infoName: '説明' },
  body: [
    { kind: 'para', text: '指定席券売機は、きっぷの購入と予約の受け取りができる機械である。' },
    {
      kind: 'section',
      id: 'sec-0001',
      title: '画面の構成',
      children: [
        {
          kind: 'para',
          text: '初期画面には「きっぷを買う」「予約を受け取る」の 2 つのボタンがある。',
        },
        {
          kind: 'figure',
          id: 'fig-0001',
          title: '初期画面',
          refs: [{ kind: 'graphic', target: 'asset-home' }],
        },
        {
          kind: 'admonition',
          level: 'note',
          children: [{ kind: 'para', text: 'ボタンの表示は設定で変えられる。' }],
        },
        {
          kind: 'table',
          title: 'ボタンと役割',
          rows: [
            ['ボタン', '役割'],
            ['きっぷを買う', '新しくきっぷを買う'],
            ['予約を受け取る', '予約したきっぷを受け取る'],
          ],
        },
        {
          kind: 'section',
          title: '詳しい手順',
          children: [
            {
              kind: 'para',
              text: '受け取りの手順は',
              refs: [{ kind: 'dmRef', target: KENBAIKI_DMC.proced, title: '指定席券売機' }],
            },
          ],
        },
      ],
    },
  ],
});

/** 箇条書き・用語・警告・注意を含む説明（往復の対象外: reader は para の中の箇条書きを読まない） */
export const descriptListsDraft = (): DraftDataModule => ({
  ...common,
  sourceId: 'topic-terms',
  kind: 'descript',
  title: { techName: '指定席券売機', infoName: '用語' },
  body: [
    {
      kind: 'section',
      title: '用語と注意',
      children: [
        { kind: 'admonition', level: 'caution', text: '扉を開けたまま機械を動かさない。' },
        { kind: 'admonition', level: 'warning', text: '内部には高電圧の部分がある。' },
        { kind: 'para', text: '画面で使う言葉は次のとおり。' },
        {
          kind: 'list',
          children: [
            { kind: 'listItem', text: '指定席: 座席を決めて買うきっぷ' },
            { kind: 'listItem', text: '自由席: 座席を決めずに買うきっぷ' },
          ],
        },
        {
          kind: 'list',
          ordered: true,
          children: [
            { kind: 'listItem', text: 'ボタンに触れる' },
            {
              kind: 'listItem',
              children: [
                { kind: 'para', text: '案内に従う' },
                {
                  kind: 'admonition',
                  level: 'note',
                  children: [{ kind: 'para', text: '音声案内もある' }],
                },
              ],
            },
          ],
        },
        {
          kind: 'list',
          title: '用語',
          children: [
            {
              kind: 'definition',
              title: '予約',
              children: [{ kind: 'para', text: '先に座席を押さえておくこと。' }],
            },
            { kind: 'definition', title: '払い戻し', text: '買ったきっぷを返してお金を戻すこと。' },
          ],
        },
      ],
    },
  ],
});

export const procedDraft = (): DraftDataModule => ({
  ...common,
  sourceId: 'proc-open-door',
  kind: 'proced',
  title: { techName: '指定席券売機', infoName: '前面扉を開ける' },
  body: [
    { kind: 'requirements', children: [{ kind: 'para', text: '電源が入っていること' }] },
    {
      kind: 'step',
      id: 'stp-0001',
      title: '扉を開ける',
      text: '保守鍵で前面扉を開ける。',
      children: [
        {
          kind: 'admonition',
          level: 'caution',
          children: [{ kind: 'para', text: '扉は重いので、手を挟まないように注意する。' }],
        },
        { kind: 'step', text: '鍵を右に回す。' },
        {
          kind: 'step',
          text: '取っ手を引く。',
          children: [
            {
              kind: 'figure',
              title: '扉',
              refs: [{ kind: 'graphic', target: 'asset-door' }],
            },
          ],
        },
      ],
    },
    {
      kind: 'step',
      title: '保守モード',
      text: '保守モードに入る。',
      refs: [{ kind: 'internalRef', target: 'stp-0001', title: '手順 1' }],
      children: [
        {
          kind: 'admonition',
          level: 'note',
          children: [{ kind: 'para', text: '画面の指示に従う。' }],
        },
      ],
    },
    { kind: 'requirements', children: [{ kind: 'para', text: '扉が閉まっていること' }] },
  ],
});

export const processDraft = (): DraftDataModule => ({
  ...common,
  sourceId: 'flow-purchase',
  kind: 'process',
  title: { techName: '指定席券売機', infoName: 'きっぷを買う流れ' },
  body: [
    {
      kind: 'sequence',
      children: [
        {
          kind: 'section',
          id: 'scr-0001',
          title: '初期画面',
          children: [
            { kind: 'step', text: '「きっぷを買う」に触れる。' },
            {
              kind: 'figure',
              title: '初期画面',
              refs: [{ kind: 'graphic', target: 'asset-home' }],
            },
          ],
        },
        {
          kind: 'section',
          title: '人数の選択',
          children: [
            { kind: 'step', text: '人数を選ぶ。' },
            {
              kind: 'dialog',
              id: 'persons',
              text: '人数を選んでください。',
              choices: [{ text: '1 人' }, { text: '2 人以上' }],
            },
          ],
        },
        {
          kind: 'if',
          id: 'isGroup',
          question: '2 人以上のとき',
          children: [
            {
              kind: 'sequence',
              children: [
                {
                  kind: 'section',
                  title: '団体の案内',
                  children: [{ kind: 'step', text: '連続した座席が選べることを伝える。' }],
                },
              ],
            },
            {
              kind: 'sequence',
              children: [
                {
                  kind: 'section',
                  title: '個人の案内',
                  children: [{ kind: 'step', text: '好みの座席を選ぶ。' }],
                },
              ],
            },
          ],
        },
        {
          kind: 'section',
          title: '座席の選択',
          refs: [{ kind: 'dmRef', target: KENBAIKI_DMC.proced, title: '指定席券売機' }],
        },
        {
          kind: 'section',
          title: '名前の入力',
          children: [
            { kind: 'step', text: '予約した人の名前を入れる。' },
            { kind: 'dialog', id: 'name', text: '名前を入れてください。' },
          ],
        },
      ],
    },
  ],
});

export const faultDraft = (): DraftDataModule => ({
  ...common,
  sourceId: 'fault-no-ticket',
  kind: 'fault',
  title: { techName: '指定席券売機', infoName: 'きっぷが出ない' },
  body: [
    {
      kind: 'step',
      id: 'stp-0001',
      text: 'プリンターの用紙の残りを調べる。',
      question: '用紙は残っているか。',
      choices: [
        { text: 'はい', next: 'stp-0002' },
        { text: 'いいえ', next: 'stp-0003' },
      ],
      children: [
        {
          kind: 'admonition',
          level: 'caution',
          children: [{ kind: 'para', text: 'カッターに触れない。' }],
        },
      ],
    },
    { kind: 'step', id: 'stp-0002', text: 'プリンターを再起動する。' },
    {
      kind: 'step',
      id: 'stp-0003',
      text: '用紙を補充する。補充の手順は',
      refs: [{ kind: 'dmRef', target: KENBAIKI_DMC.proced, title: '指定席券売機' }],
    },
  ],
});

export const pmDraft = (): DraftDataModule => ({
  ...common,
  sourceId: 'manual-kenbaiki',
  kind: 'pm',
  title: { techName: '指定席券売機', infoName: '取扱説明' },
  body: [
    {
      kind: 'section',
      title: '概要',
      children: [
        {
          kind: 'entry',
          refs: [{ kind: 'dmRef', target: KENBAIKI_DMC.descript, title: '指定席券売機' }],
        },
      ],
    },
    {
      kind: 'section',
      title: '操作',
      children: [
        {
          kind: 'entry',
          refs: [{ kind: 'dmRef', target: KENBAIKI_DMC.proced, title: '指定席券売機' }],
        },
        {
          kind: 'entry',
          refs: [{ kind: 'dmRef', target: KENBAIKI_DMC.process, title: '指定席券売機' }],
        },
        {
          kind: 'section',
          title: '保守',
          children: [
            {
              kind: 'entry',
              refs: [{ kind: 'dmRef', target: KENBAIKI_DMC.fault, title: '指定席券売機' }],
            },
            {
              kind: 'entry',
              refs: [{ kind: 'pmRef', target: 'KENBAIKI-K0001-MAINT-00', title: '保守マニュアル' }],
            },
          ],
        },
      ],
    },
  ],
});
