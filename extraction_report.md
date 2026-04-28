# Public Corpus Re-extraction Report

This run uses corpus-provided labels first, then applies conservative taxonomy suggestions.

## Files / Schema Notes
- vendor/SWSR/SexComment.csv columns: ['index', 'weibo_id', 'comment_text', 'gender', 'location', 'like', 'date', 'label', 'category', 'target']
- vendor/SWSR/SexWeibo.csv columns: ['weibo_id', 'weibo_text', 'keyword', 'user_gender', 'user_location', 'user_following', 'user_follower', 'weibo_like', 'weibo_repost', 'weibo_comment', 'weibo_date']
- vendor/SWSR/SexHateLex.txt found but skipped because it is lexicon-only, not sentence corpus
- vendor/COLDataset/dev.csv columns: ['Unnamed: 0', 'split', 'topic', 'label', 'TEXT']
- vendor/COLDataset/test.csv columns: ['Unnamed: 0', 'split', 'topic', 'label', 'fine-grained-label', 'TEXT']
- vendor/COLDataset/train.csv columns: ['Unnamed: 0', 'split', 'topic', 'label', 'TEXT']
- vendor/NLPCC-2025-Shared-Task-7/data/test/classification and mitigation/data.json records: 200
- vendor/NLPCC-2025-Shared-Task-7/data/test/detection/data.json records: 200
- vendor/NLPCC-2025-Shared-Task-7/data/test_gt/classification and mitigation/biased.json records: 200
- vendor/NLPCC-2025-Shared-Task-7/data/test_gt/detection/biased.json records: 100
- vendor/NLPCC-2025-Shared-Task-7/data/test_gt/detection/non-biased.json records: 100
- vendor/NLPCC-2025-Shared-Task-7/data/train/biased.json records: 4172
- vendor/NLPCC-2025-Shared-Task-7/data/train/non-biased.json records: 21418
- vendor/NLPCC-2025-Shared-Task-7/data/valid/biased.json records: 516
- vendor/NLPCC-2025-Shared-Task-7/data/valid/non-biased.json records: 516

## Raw Extracted
- total: 92417
- by source_dataset:
  - NLPCC-2025/CORGI-style: 47761
  - SWSR: 19795
  - COLDataset-gender: 14270
  - SWSR-keyword-weibo: 10591
- by candidate_type:
  - neutral: 48770
  - biased: 26406
  - boundary: 17241
- by suggested category:
  - C0: 62112
  - C1: 6220
  - C2: 760
  - C3: 5928
  - C4: 1741
  - C5: 939
  - C6: 2239
  - C7: 154
  - C8: 11915
  - C9: 409

## After Filtering
- total: 32853
- by source_dataset:
  - NLPCC-2025/CORGI-style: 13183
  - SWSR: 7687
  - COLDataset-gender: 7067
  - SWSR-keyword-weibo: 4916
- by candidate_type:
  - neutral: 12527
  - biased: 11773
  - boundary: 8553
- by suggested category:
  - C0: 17316
  - C1: 2541
  - C2: 426
  - C3: 2267
  - C4: 838
  - C5: 517
  - C6: 1066
  - C7: 65
  - C8: 7477
  - C9: 340

## Sampled
- total: 120
- by source_dataset:
  - NLPCC-2025/CORGI-style: 60
  - SWSR: 32
  - COLDataset-gender: 28
- by candidate_type:
  - biased: 100
  - neutral: 12
  - boundary: 8
- by suggested category:
  - C0: 12
  - C1: 13
  - C2: 13
  - C3: 8
  - C4: 13
  - C5: 12
  - C6: 14
  - C7: 11
  - C8: 12
  - C9: 12

## Filtering Drops
- no_gender_cue: 50197
- too_short: 8189
- duplicate: 950
- too_long: 118
- too_explicit: 107
- mostly_non_chinese: 3

## Sample Verification
- strict source-labeled biased samples: 100
- non-C0 taxonomy suggestions: 108
- needs_manual_review: 14

## Notes
- SWSR SexHateLex is lexicon-only, so it is not converted into sentence samples.
- SWSR SexWeibo has keyword-topic posts but no sentence-level sexism labels; short chunks are kept only as boundary candidates.
- NLPCC/CORGI-style test files without ground-truth labels are kept as boundary candidates, not strict biased examples.
- Suggested categories and rule ids are for manual review; they are not final gold labels.

## Sample Rows
- pub-50191 | NLPCC-2025/CORGI-style | biased | C1 | 真正聪明的女人应该是利用男人，欺骗男人，占男人便宜，如果和男人吵架，那就是笨的女人
- pub-56052 | NLPCC-2025/CORGI-style | biased | C1 | 她是那么弱小，他一定很粗蠢，一定会欺负她
- pub-90431 | NLPCC-2025/CORGI-style | biased | C1 | 通常，她们只是满脑子想着找个男人，当然，是想找爱她们的男人
- pub-46019 | NLPCC-2025/CORGI-style | biased | C1 | 她看不出这个题目蠢在哪里，她的智力刚开窍，还没有得到发展
- pub-49302 | NLPCC-2025/CORGI-style | biased | C1 | 文笔一般，没有内涵，没有逻辑，一篇真正矫情做作的伪文艺女青年随笔
- pub-51669 | NLPCC-2025/CORGI-style | biased | C1 | 她并不适合担当一个伟大的文学沙龙的女主人，这使得他感到非常痛苦
- pub-46375 | NLPCC-2025/CORGI-style | biased | C1 | 姚太太对女儿说：“这位‘标准美人’看上来顶伶俐的，怎么竟是个笨蛋，听音乐嫌闹
- pub-55693 | NLPCC-2025/CORGI-style | biased | C1 | 他虽然口头上也主张解决妇女问题，但心底里却认为女人都是愚蠢的，猥琐的，除了他所热恋的女人之外，譬如他现在所爱的格拉别茨
- pub-51583 | NLPCC-2025/CORGI-style | biased | C1 | 尽管伊秋说起话来有点笨嘴拙舌，体态也显得臃肿蠢钝，但是她却长了一张俊美的脸孔，一双最为温顺的羚羊式的大眼睛，乌黑的眉毛又粗又长
- pub-47297 | NLPCC-2025/CORGI-style | biased | C1 | 脑子里想的是如何大做生意
- pub-53460 | NLPCC-2025/CORGI-style | biased | C1 | 她听见放音机在呼号着一种矫揉造作的娇媚蠢笨的声音
- pub-55834 | NLPCC-2025/CORGI-style | biased | C1 | 结果也就变得越发愚蠢