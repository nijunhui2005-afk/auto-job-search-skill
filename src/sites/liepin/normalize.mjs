/**
 * 职位记录归一化。
 *
 * 猎聘 jobCardList 的条目形状是 { job, comp, recruiter, dataInfo, dataParams }，
 * 但不同接口/版本字段名会漂移，所以统一用 `pick()` 按候选路径取值，
 * 取不到就留空 —— 绝不因为某个字段改名就让整条记录丢掉。
 * 同时保留 `raw`，便于事后核对真实字段名。
 */

/** 按候选路径列表取第一个非空值。支持 'a.b.c' 与数组下标 'a.0.b' */
export function pick(obj, ...paths) {
  for (const p of paths) {
    let cur = obj;
    let ok = true;
    for (const seg of String(p).split('.')) {
      if (cur === null || cur === undefined) {
        ok = false;
        break;
      }
      cur = cur[seg];
    }
    if (ok && cur !== null && cur !== undefined && cur !== '') return cur;
  }
  return undefined;
}

const asText = (v) => (v === undefined || v === null ? '' : String(v)).replace(/\s+/g, ' ').trim();

export function normalizeJob(raw) {
  const job = raw.job || raw;
  const comp = raw.comp || {};
  const recruiter = raw.recruiter || {};
  const dataInfo = raw.dataInfo || {};

  const jobId = asText(pick(job, 'jobId', 'id', 'jobIdEnc', 'encJobId'));
  // 实测 job.link = https://www.liepin.com/lptjob/<id>
  const link =
    asText(pick(job, 'link', 'jobUrl', 'dataParams.url')) ||
    (jobId ? `https://www.liepin.com/lptjob/${jobId}` : '');

  // dataParams 是 JSON 字符串，含发消息所需的 imId / userId / jobKind
  let dp = raw.dataParams;
  if (typeof dp === 'string' && dp.startsWith('{')) {
    try {
      dp = JSON.parse(dp);
    } catch {
      /* 保持原样 */
    }
  }

  return {
    jobId,
    link,
    title: asText(pick(job, 'title', 'jobTitle', 'jobName', 'name')),
    salary: asText(pick(job, 'salary', 'salaryText', 'salaryReal', 'salary60', 'salaryDesc')),
    area: asText(pick(job, 'dq', 'dqName', 'addr', 'area', 'location', 'jobArea', 'workCity')),
    workYear: asText(pick(job, 'workYear', 'workYearName', 'workYearCode')),
    eduLevel: asText(pick(job, 'eduLevel', 'eduLevelName', 'education', 'eduLevelCode')),
    jobKind: asText(pick(job, 'jobKind')),
    campusJobKind: asText(pick(job, 'campusJobKind')),
    pubTime: asText(pick(job, 'refreshTime', 'pubTime', 'updateTime', 'createTime')),
    labels: pick(job, 'labels', 'tags', 'welfareList', 'jobLabels') || [],
    topJob: pick(job, 'topJob') === true,
    advViewFlag: pick(job, 'advViewFlag') === true,
    // 列表页特有的去重/埋点串，避免写进 jobs.jsonl 时重复冗长
    dataPromId: asText(pick(job, 'dataPromId')),

    company: asText(pick(comp, 'compName', 'name', 'companyName', 'compFullName')),
    companyId: asText(pick(comp, 'compId', 'id', 'companyId')),
    companyLink: asText(pick(comp, 'link')),
    companyScale: asText(pick(comp, 'compScale', 'compScaleName', 'scale', 'compScaleCode')),
    companyIndustry: asText(pick(comp, 'compIndustry', 'industry', 'compIndustryName')),
    companyStage: asText(pick(comp, 'compStage', 'compStageName', 'financeStage')),
    companyKind: asText(pick(comp, 'compKind', 'compKindName', 'compNature')),

    recruiterName: asText(pick(recruiter, 'recruiterName', 'name', 'realName', 'nickName')),
    recruiterTitle: asText(pick(recruiter, 'recruiterTitle', 'title', 'position', 'duty')),
    recruiterImId: asText(pick(recruiter, 'imId', 'userId', 'recruiterId', 'imUserId')),
    recruiterUserId: asText(pick(recruiter, 'userId', 'recruiterId')),
    recruiterImUserType: asText(pick(recruiter, 'imUserType')),
    // 接口直接告诉了我们是否已经沟通过 —— 这是去重的权威信源
    chatted: pick(recruiter, 'chatted') === true,
    recruiterOnlineText: asText(pick(recruiter, 'imShowText')),
    recruiterImStatus: pick(recruiter, 'imStatus') === true,
    recruiterInDay: pick(recruiter, 'inDay') === true,

    dataParams: dp,
    dataInfo,

    // AI 打分的输入文本（列表页只有标题+公司+标签，详情页会补全 description）
    description: asText(pick(job, 'jobDescribe', 'description', 'jobDescription', 'detail')),
    raw,
  };
}

/** 关键词预过滤：命中排除词直接丢弃，省 LLM token */
export function prefilter(job, criteria) {
  const hay = [job.title, job.company, job.companyIndustry, job.area].join(' ');
  for (const bad of criteria.excludeKeywords || []) {
    if (bad && hay.includes(bad)) return { keep: false, reason: `命中排除词「${bad}」` };
  }
  for (const bad of criteria.excludeCompanies || []) {
    if (bad && job.company && job.company.includes(bad)) {
      return { keep: false, reason: `命中黑名单公司「${bad}」` };
    }
  }
  for (const must of criteria.mustHave || []) {
    if (must && !hay.includes(must)) return { keep: false, reason: `缺少硬性要求「${must}」` };
  }
  return { keep: true, reason: '' };
}

/** 地区锁定：临港这类子区域往往不在 dq 码表里，只能靠文本命中 */
export function matchesLocation(job, criteria) {
  if (!criteria.locationKeywords?.length) return { ok: true, matched: [], top: false };
  const hay = [job.area, job.title, job.company].join(' ');
  const matched = criteria.locationKeywords.filter((k) => k && hay.includes(k));
  const top = criteria.locationTopPreference ? hay.includes(criteria.locationTopPreference) : false;
  return { ok: matched.length > 0, matched, top };
}

export function jobSummaryLine(job) {
  return [
    job.title || '(无标题)',
    job.company ? `@${job.company}` : '',
    job.area ? `[${job.area}]` : '',
    job.salary || '',
    job.eduLevel || '',
    job.workYear || '',
  ]
    .filter(Boolean)
    .join('  ');
}
