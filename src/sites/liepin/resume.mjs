/**
 * 把候选人自己的猎聘简历转成给 LLM 看的紧凑 Markdown。
 *
 * 为什么要自动抓而不是让用户手填：
 *   打招呼语要引用"我真正做过什么"。手填的背景往往写成简历套话，
 *   而猎聘上的简历是用户真实维护过的、结构化的，信息密度更高也更准。
 *
 * 实测：com.liepin.cresume.web-resume-detail 用 {"data":{}} 即可取全量。
 * 另外 get-current-userinfo 会带出平台默认打招呼语（sayHiText），
 * 那正是我们要替换掉的模板话术，可作对照。
 */

import { pick } from './normalize.mjs';

const clean = (v) => (v === undefined || v === null ? '' : String(v)).replace(/\s+/g, ' ').trim();

export async function fetchResumeRaw(api) {
  const res = await api.call('com.liepin.cresume.web-resume-detail', { body: { data: {} } });
  return res.json.data;
}

export async function fetchUserInfo(api) {
  const res = await api.call('com.liepin.cresume.get-current-userinfo', {
    body: { imId: '', imApp: '1' },
  });
  return res.json.data;
}

export async function fetchExpect(api) {
  const res = await api.call('com.liepin.csearch.pc.get-valid-expect-info', { body: { data: {} } });
  return res.json.data;
}

function formatBase(d) {
  const b = d.baseInfo || {};
  const bits = [
    clean(pick(b, 'name', 'realName', 'userName')) && `姓名: ${clean(pick(b, 'name', 'realName', 'userName'))}`,
    clean(pick(b, 'sex', 'sexName', 'gender')) && `性别: ${clean(pick(b, 'sex', 'sexName', 'gender'))}`,
    clean(pick(b, 'birthday', 'birthdate', 'age')) && `出生/年龄: ${clean(pick(b, 'birthday', 'birthdate', 'age'))}`,
    clean(pick(b, 'eduLevel', 'degree', 'eduLevelName')) && `学历: ${clean(pick(b, 'eduLevel', 'degree', 'eduLevelName'))}`,
    clean(pick(b, 'workYear', 'workYearName', 'workExp')) && `工作年限: ${clean(pick(b, 'workYear', 'workYearName', 'workExp'))}`,
    clean(pick(b, 'dqName', 'city', 'address')) && `所在地: ${clean(pick(b, 'dqName', 'city', 'address'))}`,
  ].filter(Boolean);
  return bits.join(' | ');
}

function formatWork(list = []) {
  if (!Array.isArray(list) || !list.length) return '';
  return list
    .map((w) => {
      const comp = clean(pick(w, 'compName', 'company', 'comp'));
      const title = clean(pick(w, 'title', 'jobTitle', 'duty'));
      const time = [clean(pick(w, 'startTime', 'timeStart')), clean(pick(w, 'endTime', 'timeEnd'))]
        .filter(Boolean)
        .join('~');
      const desc = clean(pick(w, 'description', 'workContent', 'dutyContent', 'content'));
      return `- ${comp} — ${title} ${time ? `(${time})` : ''}${desc ? `\n  ${desc.slice(0, 500)}` : ''}`;
    })
    .join('\n');
}

function formatProjects(list = []) {
  if (!Array.isArray(list) || !list.length) return '';
  return list
    .map((p) => {
      const name = clean(pick(p, 'projectName', 'name', 'title'));
      const role = clean(pick(p, 'role', 'duty', 'jobTitle'));
      const desc = clean(pick(p, 'description', 'projectDesc', 'content', 'dutyContent'));
      const tech = clean(pick(p, 'techStack', 'skill', 'keyWords'));
      return `- ${name}${role ? ` (${role})` : ''}${tech ? ` [${tech}]` : ''}${desc ? `\n  ${desc.slice(0, 500)}` : ''}`;
    })
    .join('\n');
}

function formatEdu(list = []) {
  if (!Array.isArray(list) || !list.length) return '';
  return list
    .map((e) => {
      const school = clean(pick(e, 'school', 'schoolName', 'compName'));
      const major = clean(pick(e, 'major', 'speciality', 'majorName'));
      const degree = clean(pick(e, 'degree', 'eduLevel', 'degreeName'));
      const time = [clean(pick(e, 'startTime', 'timeStart')), clean(pick(e, 'endTime', 'timeEnd'))]
        .filter(Boolean)
        .join('~');
      return `- ${school} ${major} ${degree} ${time}`.replace(/\s+/g, ' ').trim();
    })
    .join('\n');
}

function formatSkills(d) {
  const out = [];
  const certs = d.credential || d.certificates;
  if (Array.isArray(certs) && certs.length) {
    out.push(
      '证书: ' +
        certs.map((c) => clean(pick(c, 'name', 'certName', 'title'))).filter(Boolean).join('、'),
    );
  }
  const skills = d.showCertiSkill || d.chosenPartnerCertiSkills || d.skills;
  if (Array.isArray(skills) && skills.length) {
    out.push(
      '技能: ' +
        skills
          .map((s) => clean(pick(s, 'name', 'skillName', 'label')))
          .filter(Boolean)
          .join('、'),
    );
  }
  const labels = d.labels;
  if (Array.isArray(labels) && labels.length) {
    out.push('标签: ' + labels.map((l) => clean(pick(l, 'name', 'label', 'value') ?? l)).filter(Boolean).join('、'));
  }
  return out.join('\n');
}

/** 生成给 LLM 用的候选人背景 Markdown */
export function formatResumeMarkdown(resume, userInfo, expect) {
  const parts = [];
  parts.push('### 基本信息');
  const base = formatBase(resume);
  const u = userInfo
    ? [
        clean(userInfo.name) && `姓名: ${userInfo.name}`,
        clean(userInfo.gender) && `性别: ${userInfo.gender}`,
        clean(userInfo.edu) && `学历: ${userInfo.edu}`,
        clean(userInfo.work) && `工作经历: ${userInfo.work}`,
        clean(userInfo.title) && `当前职位: ${userInfo.title}`,
        clean(userInfo.company) && `当前公司: ${userInfo.company}`,
        clean(userInfo.dqName) && `所在地: ${userInfo.dqName}`,
      ]
        .filter(Boolean)
        .join(' | ')
    : '';
  parts.push(base || u || '(空)');
  if (u && base && u !== base) parts.push(`账号资料: ${u}`);

  const skills = formatSkills(resume);
  if (skills) parts.push(`\n### 技能与证书\n${skills}`);

  const edu = formatEdu(resume.eduExperiences);
  if (edu) parts.push(`\n### 教育经历\n${edu}`);

  const work = formatWork(resume.workExperiences);
  if (work) parts.push(`\n### 工作/实习经历\n${work}`);

  const proj = formatProjects(resume.projectExperiences);
  if (proj) parts.push(`\n### 项目经历\n${proj}`);

  const research = formatProjects(resume.researchExperiences);
  if (research) parts.push(`\n### 科研经历\n${research}`);

  if (expect?.validExpects?.length) {
    const e = expect.validExpects[0];
    parts.push(
      `\n### 平台内求职期望\n` +
        [
          e.expectJobtitleName && `岗位: ${e.expectJobtitleName}`,
          e.expectDqName && `城市: ${e.expectDqName}`,
          e.expectIndustryName && `行业: ${e.expectIndustryName}`,
          (e.expectMonthSalaryLower || e.expectMonthSalaryUpper) &&
            `月薪: ${e.expectMonthSalaryLower}-${e.expectMonthSalaryUpper}K x${e.expectSalmonths ?? 12}`,
        ]
          .filter(Boolean)
          .join(' | '),
    );
  }
  return parts.join('\n');
}

/** 如果简历里信息太少，别硬用 —— 下游会退回让用户补 config/profile.md */
export function resumeQuality(md) {
  const len = md.length;
  const hasProject = /### 项目经历/.test(md);
  const hasWork = /### 工作\/实习经历/.test(md);
  return { len, hasProject, hasWork, usable: len > 150 };
}
