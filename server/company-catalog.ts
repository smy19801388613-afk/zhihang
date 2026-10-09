/** Curated official career entrances checked on 2026-10-02.
 * A checked entrance is not evidence of an open job or permission to automate it.
 * Category/role matching below proposes searches; it never claims a vacancy.
 */
export type CompanyCategory = 'internet' | 'manufacturing' | 'professional' | 'consumer' | 'finance';
export interface CatalogCompany {
  id: string; name: string; category: CompanyCategory; industry: string;
  careerUrl: string; checkedAt: string; context: string; logoUrl?: string;
}
export const COMPANY_CATALOG: readonly CatalogCompany[] = [
  { id: 'tencent', name: '腾讯', category: 'internet', industry: '互联网与数字服务', careerUrl: 'https://join.qq.com/', logoUrl: 'https://join.qq.com/static2/newstatic/image/logo_black.png', context: '从官方校招入口按所选职能与城市检索。', checkedAt: '2026-10-03' },
  { id: 'netease', name: '网易', category: 'internet', industry: '互联网与数字服务', careerUrl: 'https://hr.163.com/job-list.html', logoUrl: 'https://hr.163.com/favicon.ico', context: '已接入官网实习岗位公开列表；仍需逐个核对实际 JD 和毕业届别。', checkedAt: '2026-10-03' },
  { id: 'bytedance', name: '字节跳动', category: 'internet', industry: '互联网与数字服务', careerUrl: 'https://jobs.bytedance.com/campus/', context: '从官方校园招聘入口检索，核对具体业务线与职责。', checkedAt: '2026-10-02' },
  { id: 'alibaba', name: '阿里巴巴', category: 'internet', industry: '互联网与数字服务', careerUrl: 'https://talent.alibaba.com/', context: '从集团招聘入口进入对应业务，核对招聘主体。', checkedAt: '2026-10-02' },
  { id: 'huawei', name: '华为', category: 'manufacturing', industry: '科技硬件与制造业', careerUrl: 'https://career.huawei.com/cn', context: '从官方招聘入口按职能检索，并核对专业要求和工作地点。', checkedAt: '2026-10-02' },
  { id: 'midea', name: '美的集团', category: 'manufacturing', industry: '家电与制造业', careerUrl: 'https://careers.midea.com/schoolOut', context: '从集团校园招聘入口检索，区分业务单元与工作地点。', checkedAt: '2026-10-02' },
  { id: 'pwc', name: '普华永道中国', category: 'professional', industry: '专业服务与咨询', careerUrl: 'https://www.pwccn.com/zh/careers.html', context: '从官方人才招聘页面进入校园招聘，核对具体服务线。', checkedAt: '2026-10-02' },
  { id: 'deloitte', name: '德勤中国', category: 'professional', industry: '专业服务与咨询', careerUrl: 'https://www.deloitte.com/cn/zh/cn-careers.html', context: '从官方职业发展页面进入校园招聘，核对团队职责与专业要求。', checkedAt: '2026-10-02' },
  { id: 'unilever', name: '联合利华', category: 'consumer', industry: '消费品', careerUrl: 'https://careers.unilever.com/en', context: '官方全球招聘入口；需筛选中国地区及适合的学生招聘项目。', checkedAt: '2026-10-02' },
  { id: 'pg', name: '宝洁', category: 'consumer', industry: '消费品', careerUrl: 'https://www.pgcareers.com/us/en', context: '官方全球招聘入口；需切换或筛选中国地区，不能据此认定本地有空缺。', checkedAt: '2026-10-02' },
  { id: 'cmb', name: '招商银行', category: 'finance', industry: '银行与金融服务', careerUrl: 'https://career.cmbchina.com/', context: '从官方招聘入口核对校招项目、总分行和工作城市。', checkedAt: '2026-10-02' },
];

export function categoriesForIndustry(industry: string): CompanyCategory[] {
  const categories: CompanyCategory[] = [];
  if (/互联网|数字服务|软件|电商|内容平台|科技平台|人工智能|AI|大模型|云计算|游戏|科技公司|信息技术/iu.test(industry)) categories.push('internet');
  if (/制造|硬件|工业|家电|汽车|新能源|通信设备/u.test(industry)) categories.push('manufacturing');
  if (/专业服务|咨询|审计|会计师/u.test(industry)) categories.push('professional');
  if (/消费品|快消|零售|品牌/u.test(industry)) categories.push('consumer');
  if (/银行|金融|保险|证券/u.test(industry)) categories.push('finance');
  return categories;
}

export function companyCoverageNotice(directions: Array<{ industry: string }>): string | undefined {
  const uncovered = [...new Set(directions.filter(direction => !categoriesForIndustry(direction.industry).length).map(direction => direction.industry))];
  return uncovered.length ? `“${uncovered.join('、')}”暂无预置企业入口。已保留所选方向，可以继续检索公开岗位，或用浏览器扩展导入；也可以提供公司官网或真实 JD。` : undefined;
}
