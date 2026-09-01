#!/usr/bin/env python3
"""要求文書の「どの判断にも接続しない散文」を検出する補助スクリプト（非ブロッキング警告）。

段落単位で次を保護し、残った段落を過剰候補として列挙する:
  P1 見出し行を含む / P2 表・箇条書き・コードフェンス / P3 要求 ID token を含む
  P4 定義・割当・除外の述語を含む / P5 同節の要求文と 3 文字以上の語彙接続を持つ
  P6 表記規約節・INDEX

実測較正（Alphora 7 文書・2026-09-02）: 候補 88 段落を人手裁定した結果、真に過剰は 10 件
（11%）で残りは規範・前提の偽陽性だった。よってこの出力は削除リストではなく
「writer が個別裁定する候補リスト」であり、機械削除・FAIL 化に使ってはならない。
要求文は総称文（欄名＋禁止/義務）で書かれ、意味の大半は節導入の定義散文に住む —
散文が多いこと自体は過剰の証拠にならない。

usage: python3 check_unlinked_prose.py <docs_dir>
"""
import sys

import re, json, sys, os, hashlib

DOCS = sys.argv[1] if len(sys.argv) > 1 else "docs/requirements"
P4 = ["とは","を指す","と呼ぶ","以下","対象外","除く","を除き","欄","区別","定義","範囲","適用","単位","形式","：",":"]
TOK = re.compile(r'[一-鿿゠-ヿ]{3,}')
PRID = re.compile(r'PR-[A-Z\-]+-\d+')

def sections(path):
    lines = open(path, encoding='utf-8').read().split('\n')
    secs = []  # (sec_title, [ (kind, [lines]) ]) kind: 'outside'/'req'
    cur = {"title": None, "blocks": []}
    mode = 'outside'; buf = []
    def flush():
        if buf: cur["blocks"].append((mode, list(buf))); buf.clear()
    for ln in lines:
        if ln.startswith('### ') and not ln.startswith('#### '):
            flush(); secs.append(cur); cur = {"title": ln, "blocks": []}; mode='outside'
        elif ln.startswith('#### '):
            flush(); mode='req'; buf.append(ln)
        elif ln.startswith('#') and not ln.startswith('###'):
            flush(); mode='outside'; buf.append(ln)
        else:
            buf.append(ln)
    flush(); secs.append(cur)
    return secs

def paragraphs(lines):
    out=[]; cur=[]
    for ln in lines:
        if ln.strip()=='':
            if cur: out.append(cur); cur=[]
        else: cur.append(ln)
    if cur: out.append(cur)
    return out

report={}; removed=[]; tot_out=0; tot_rm=0; tot_all=0
persec={}
for fn in sorted(os.listdir(DOCS)):
    if not fn.endswith('.md') or fn=='INDEX.md': continue
    path=os.path.join(DOCS,fn)
    text=open(path,encoding='utf-8').read(); tot_all+=len(text)
    secs=sections(path)
    persec[fn]=[]
    for s in secs:
        reqtext=' '.join(' '.join(b[1]) for b in s["blocks"] if b[0]=='req')
        nreq=reqtext.count('#### ')
        persec[fn].append((s["title"], nreq))
        vocab=set(TOK.findall(reqtext))
        for kind, blines in s["blocks"]:
            if kind=='req': continue
            for para in paragraphs(blines):
                ptxt='\n'.join(para)
                if fn=='guideline.md' and s["title"] and '規約' in s["title"]:
                    rule='P6'
                elif any(l.startswith('#') for l in para): rule='P1'
                elif any(('|' in l) or l.lstrip().startswith(('- ','* ','1.','2.','3.')) or l.lstrip().startswith('```') for l in para): rule='P2'
                elif PRID.search(ptxt): rule='P3'
                elif any(m in ptxt for m in P4): rule='P4'
                elif any(t in vocab for t in TOK.findall(ptxt)): rule='P5'
                else: rule=None
                if not any(l.startswith('#') for l in para):
                    tot_out+=len(ptxt)
                if rule is None:
                    tot_rm+=len(ptxt)
                    removed.append({"doc":fn,"section":s["title"],"chars":len(ptxt),"text":ptxt})
print("removed_paragraphs", len(removed), "removed_chars", tot_rm, "outside_prose_chars", tot_out, "total_chars", tot_all)
print("removed_char_ratio", round(tot_rm/tot_all,4), "unlinked_prose_ratio", round(tot_rm/max(tot_out,1),4))
for r in removed[:20]: print("--", r["doc"], r["section"], r["chars"], r["text"][:60])
print("=== sections with >=1 #### ===")
tot1=0;tot2=0
for fn,ss in persec.items():
    valid=[x for x in ss if x[1]>=1]
    one=len([x for x in valid if x[1]==1]); multi=len([x for x in valid if x[1]>=2])
    tot1+=one; tot2+=multi
    print(fn, "sections_all", len(ss), "with_req", len(valid), "single", one, "multi", multi)
print("TOTAL with_req", tot1+tot2, "single", tot1, "multi", tot2)
