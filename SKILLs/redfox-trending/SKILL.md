---
name: redfox-trending
description: 使用红狐 API 查抖音和小红书的当前热榜、近期增长榜和女装相关榜。适用于“红狐查榜”“女装热点”“WEFTORY 查榜”。
---

在技能目录运行 `python -X utf8 "{baseDir}/redfox.py" --json`，使用进程环境中的 REDFOX_API_KEY。缺少密钥时提示用户在本机配置。展示查询时间、平台源快照时间、实际条数和 notices；注明增长指标是平台热度还是累计播放量，女装补充标签附样本命中数。每榜最多 15 条。
