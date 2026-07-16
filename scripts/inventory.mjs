// 规范化车型库 —— 从用户 2026-06-23 提供的三个报价表手工编码
//   1) 副本used_car_price_by_year_copy_ready.xlsx  （丰田/现代/起亚 混动，按年份 FOB）
//   2) List of the CARS-11.xlsx                    （同上，含 Mr.Sino 价 + FOB China 价）
//   3) 副本比亚迪库存6月21号更新(1).xlsx            （比亚迪真实现车：车架号/里程/颜色/FOB）
// segment: sedan / suv-small / suv-compact / suv-mid / suv-large / offroad / pickup / mpv / luxury
// stock: 'in'=有现车(比亚迪那批，最强钩子) | 'price'=有现成报价可订(丰田系) | 'source'=能订货但无现价

export const INVENTORY = [
  // ---------- 比亚迪现车（库存6月21号，FOB USD 取整）----------
  { key: 'byd-qin-plus-ev',  brand: 'BYD', name: '秦PLUS EV / Qin Plus EV',        seg: 'sedan',      fuel: 'EV',    fobLow: 12800, fobHigh: 12800, stock: 'in', note: '420km 领先型 现车' },
  { key: 'byd-qin-l-dmi',    brand: 'BYD', name: '秦L DM-i / Qin L DM-i',          seg: 'sedan',      fuel: 'PHEV',  fobLow: 12800, fobHigh: 12800, stock: 'in', note: '120km 超越型 现车 ×2' },
  { key: 'byd-qin-l-ev',     brand: 'BYD', name: '秦L EV / Qin L EV',              seg: 'sedan',      fuel: 'EV',    fobLow: 15300, fobHigh: 15300, stock: 'in', note: '545km 卓越 现车' },
  { key: 'byd-han-dmi',      brand: 'BYD', name: '汉 DM-i / Han DM-i',             seg: 'sedan',      fuel: 'PHEV',  fobLow: 19400, fobHigh: 20700, stock: 'in', note: '智驾激光雷达旗舰 现车 ×2' },
  { key: 'byd-han-ev',       brand: 'BYD', name: '汉 EV / Han EV',                 seg: 'sedan',      fuel: 'EV',    fobLow: 24000, fobHigh: 24300, stock: 'in', note: '701km 激光雷达 现车 ×2' },
  { key: 'byd-han-l-ev',     brand: 'BYD', name: '汉L EV / Han L EV',              seg: 'sedan',      fuel: 'EV',    fobLow: 28800, fobHigh: 29200, stock: 'in', note: '四驱激光雷达旗舰 现车 ×3' },
  { key: 'byd-han-l-dmp',    brand: 'BYD', name: '汉L DM-p / Han L DM-p',          seg: 'sedan',      fuel: 'PHEV',  fobLow: 25200, fobHigh: 25200, stock: 'in', note: '四驱激光雷达旗舰 现车' },
  { key: 'byd-seal-06-dm',   brand: 'BYD', name: '海豹06 DM-i / Seal 06 DM-i',     seg: 'sedan',      fuel: 'PHEV',  fobLow: 15300, fobHigh: 15300, stock: 'in', note: '旅行版150km旗舰 现车' },
  { key: 'byd-sealion-06',   brand: 'BYD', name: '海狮06 EV/DM-i / Sealion 06',    seg: 'sedan',      fuel: 'EV/PHEV', fobLow: 17400, fobHigh: 20000, stock: 'in', note: '领航/领航plus 现车 ×4' },
  { key: 'byd-yuan-up',      brand: 'BYD', name: '元UP / Yuan UP',                 seg: 'suv-small',  fuel: 'EV',    fobLow: 12700, fobHigh: 12700, stock: 'in', note: '601km超越型 现车' },
  { key: 'byd-yuan-plus',    brand: 'BYD', name: '元PLUS / Atto 3 / Yuan Plus',    seg: 'suv-compact',fuel: 'EV',    fobLow: 15800, fobHigh: 16200, stock: 'in', note: '智驾510km超越型 现车 ×2' },
  { key: 'byd-sealion-05',   brand: 'BYD', name: '海狮05 EV / Sealion 05 EV',      seg: 'suv-compact',fuel: 'EV',    fobLow: 14700, fobHigh: 15500, stock: 'in', note: '520km智航版 现车 ×3' },
  { key: 'byd-song-pro',     brand: 'BYD', name: '宋Pro DM-i / Song Pro',          seg: 'suv-compact',fuel: 'PHEV',  fobLow: 12400, fobHigh: 12400, stock: 'in', note: '荣耀版110km卓越 现车' },
  { key: 'byd-song-plus',    brand: 'BYD', name: '宋PLUS DM-i/EV / Song Plus',     seg: 'suv-compact',fuel: 'PHEV/EV',fobLow: 16000, fobHigh: 16400, stock: 'in', note: '112km尊荣 / 605旗舰 现车 ×2' },
  { key: 'byd-song-l',       brand: 'BYD', name: '宋L EV/DM-i / Song L',           seg: 'suv-mid',    fuel: 'EV/PHEV',fobLow: 16700, fobHigh: 23900, stock: 'in', note: '662km卓越智驾 / 160km 现车 ×5' },
  { key: 'byd-frigate-05',   brand: 'BYD', name: '护卫舰05 DM-i / Frigate 05',     seg: 'suv-mid',    fuel: 'PHEV',  fobLow: 15600, fobHigh: 15600, stock: 'in', note: '荣耀版100km尊贵型 现车' },
  { key: 'byd-tang',         brand: 'BYD', name: '唐 DM-i / Tang (7座)',           seg: 'suv-large',  fuel: 'PHEV',  fobLow: 16800, fobHigh: 20700, stock: 'in', note: '115km旗舰/荣耀版 7座 现车 ×5' },
  { key: 'byd-tang-l',       brand: 'BYD', name: '唐L DM/EV / Tang L',             seg: 'suv-large',  fuel: 'PHEV/EV',fobLow: 28300, fobHigh: 34600, stock: 'in', note: '激光雷达旗舰 现车 ×10' },
  { key: 'byd-ti3',          brand: 'BYD', name: '钛3 / Fangchengbao Ti3',         seg: 'suv-small',  fuel: 'EV',    fobLow: 21200, fobHigh: 21200, stock: 'in', note: '四驱Ultra 方盒子 现车' },
  { key: 'byd-bao-5',        brand: 'BYD', name: '豹5 / Fangchengbao Bao 5',       seg: 'offroad',    fuel: 'PHEV',  fobLow: 28300, fobHigh: 33100, stock: 'in', note: '探索版/天神智驾Ultra 硬派越野 现车 ×3' },
  { key: 'byd-bao-8',        brand: 'BYD', name: '豹8 / Fangchengbao Bao 8',       seg: 'offroad',    fuel: 'PHEV',  fobLow: 48700, fobHigh: 50100, stock: 'in', note: '智勇旗舰 6/7座 现车 ×3' },
  { key: 'byd-xia',          brand: 'BYD', name: '夏 / Xia MPV',                   seg: 'mpv',        fuel: 'PHEV',  fobLow: 33700, fobHigh: 33700, stock: 'in', note: '218km卓越 MPV 现车' },
  { key: 'byd-denza',        brand: 'Denza','name': '腾势 N9/N8 / Denza',          seg: 'luxury',     fuel: 'PHEV',  fobLow: 40900, fobHigh: 45600, stock: 'in', note: 'N9旗舰/N8L旗舰 现车 ×3' },
  { key: 'byd-yangwang-u7',  brand: 'Yangwang','name': '仰望U7 / Yangwang U7',     seg: 'luxury',     fuel: 'EV',    fobLow: 78800, fobHigh: 78800, stock: 'in', note: '5座豪华版 现车' },
  { key: 'avatr',            brand: 'Avatr','name': '阿维塔 / Avatr',              seg: 'suv-mid',    fuel: 'EV',    fobLow: 23300, fobHigh: 23300, stock: 'in', note: 'Pro纯电版 现车' },
  { key: 'deepal',           brand: 'Deepal','name': '深蓝 / Deepal',             seg: 'suv-compact',fuel: 'EV',    fobLow: 17900, fobHigh: 17900, stock: 'in', note: '230Ultra华为智驾SE 现车' },

  // ---------- 丰田/现代/起亚 混动（按年份 FOB China，可订；fobLow=2022用 fobHigh=新车）----------
  { key: 'toyota-corolla',       brand: 'Toyota', name: 'Toyota Corolla Hybrid',        seg: 'sedan',      fuel: 'Hybrid', fobLow: 10700, fobHigh: 14590, stock: 'price', note: '1.8L 混动 先锋/精英版 (22款¥10.7k→新¥14.6k)' },
  { key: 'toyota-corolla-cross', brand: 'Toyota', name: 'Toyota Corolla Cross Hybrid',  seg: 'suv-compact',fuel: 'Hybrid', fobLow: 12800, fobHigh: 16190, stock: 'price', note: '2.0L 混动 (22款¥12.8k→新¥16.2k)' },
  { key: 'toyota-frontlander',   brand: 'Toyota', name: 'Toyota Frontlander Hybrid',    seg: 'suv-compact',fuel: 'Hybrid', fobLow: 13200, fobHigh: 17190, stock: 'price', note: '2.0L 混动 卡罗拉锐放姊妹 (22款¥13.2k→新¥17.2k)' },
  { key: 'toyota-rav4',          brand: 'Toyota', name: 'Toyota RAV4 Hybrid',           seg: 'suv-mid',    fuel: 'Hybrid', fobLow: 17800, fobHigh: 30590, stock: 'price', note: '2.0/2.5L 2WD/4WD 混动 (22款¥17.8k→新旗舰¥30.6k)' },
  { key: 'toyota-camry',         brand: 'Toyota', name: 'Toyota Camry Hybrid',          seg: 'sedan',      fuel: 'Hybrid', fobLow: 16400, fobHigh: 26500, stock: 'price', note: '2.0/2.5L 混动 (22款¥16.4k→新旗舰¥26.5k)' },
  { key: 'hyundai-elantra',      brand: 'Hyundai',name: 'Hyundai Elantra',              seg: 'sedan',      fuel: 'Gas',    fobLow: 8300,  fobHigh: 12890, stock: 'price', note: '1.5L CVT (22款¥8.3k→新¥12.9k)' },
  { key: 'kia-sportage',         brand: 'Kia',    name: 'Kia Sportage',                 seg: 'suv-compact',fuel: 'Gas',    fobLow: 12200, fobHigh: 18790, stock: 'price', note: '1.5T 2WD (22款¥12.2k→新¥18.8k)' },
]

export const INV_BY_KEY = Object.fromEntries(INVENTORY.map((v) => [v.key, v]))

// 客户提到的任意车型 → 推荐什么。规则按优先级从上到下匹配（先具体后泛化）。
// rec: 推荐的 INVENTORY key 列表（首个为主推）。kind: 'exact'=我直接有/能现成报价 | 'substitute'=转推现车替代 | 'source'=原车能订货
// label: 客户原意向的可读名（出现在报告里）
export const INTEREST_RULES = [
  // ===== 比亚迪：客户想要的我直接有现车（最强钩子）=====
  { re: /\batto\s*3\b|yuan\s*plus|元\s*plus|\bys11\b/i,         label: 'BYD Atto 3 / 元Plus',  rec: ['byd-yuan-plus'], kind: 'exact' },
  { re: /yuan\s*up|元\s*up|atto\s*2|\bseagull\b|海鸥|dolphin|海豚/i, label: 'BYD 小型EV(海鸥/元UP)', rec: ['byd-yuan-up', 'byd-qin-plus-ev'], kind: 'substitute' },
  { re: /qin\s*plus|秦\s*plus|qin\s*l|秦\s*l|\bqin\b|秦/i,        label: 'BYD Qin Plus / 秦',    rec: ['byd-qin-l-dmi', 'byd-qin-plus-ev', 'byd-qin-l-ev'], kind: 'exact' },
  { re: /song\s*plus|宋\s*plus/i,                                label: 'BYD Song Plus / 宋Plus', rec: ['byd-song-plus'], kind: 'exact' },
  { re: /song\s*pro|宋\s*pro/i,                                  label: 'BYD Song Pro / 宋Pro', rec: ['byd-song-pro'], kind: 'exact' },
  { re: /song\s*l\b|宋\s*l\b/i,                                  label: 'BYD Song L / 宋L',     rec: ['byd-song-l'], kind: 'exact' },
  { re: /\bsong\b|宋(?!\s*l)/i,                                  label: 'BYD Song / 宋',        rec: ['byd-song-plus', 'byd-song-l'], kind: 'exact' },
  { re: /tang\s*l|唐\s*l/i,                                      label: 'BYD Tang L / 唐L',     rec: ['byd-tang-l'], kind: 'exact' },
  { re: /\btang\b|唐/i,                                          label: 'BYD Tang / 唐 (7座)',  rec: ['byd-tang', 'byd-tang-l'], kind: 'exact' },
  { re: /han\s*l|汉\s*l/i,                                       label: 'BYD Han L / 汉L',      rec: ['byd-han-l-ev', 'byd-han-l-dmp'], kind: 'exact' },
  { re: /\bhan\b|汉(?!\s*l)/i,                                   label: 'BYD Han / 汉',         rec: ['byd-han-dmi', 'byd-han-ev'], kind: 'exact' },
  { re: /frigate|护卫舰|destroyer\s*05|驱逐舰05/i,               label: 'BYD 护卫舰 / Frigate',  rec: ['byd-frigate-05'], kind: 'exact' },
  { re: /sealion|海狮/i,                                        label: 'BYD Sealion / 海狮',   rec: ['byd-sealion-06', 'byd-sealion-05'], kind: 'exact' },
  { re: /\bseal\b|海豹/i,                                        label: 'BYD Seal / 海豹',      rec: ['byd-seal-06-dm'], kind: 'exact' },
  { re: /bao\s*5|豹\s*5|leopard\s*5|fangchengbao\s*5|方程豹5/i,  label: 'BYD 豹5 / Bao 5',      rec: ['byd-bao-5'], kind: 'exact' },
  { re: /bao\s*8|豹\s*8|leopard\s*8|方程豹8/i,                   label: 'BYD 豹8 / Bao 8',      rec: ['byd-bao-8'], kind: 'exact' },
  { re: /\bti\s*3\b|钛\s*3|titanium\s*3?/i,                      label: 'BYD 钛3 / Ti3',        rec: ['byd-ti3'], kind: 'exact' },
  { re: /denza|腾势/i,                                          label: '腾势 / Denza',         rec: ['byd-denza'], kind: 'exact' },
  { re: /yangwang|仰望/i,                                       label: '仰望 / Yangwang',      rec: ['byd-yangwang-u7'], kind: 'exact' },
  { re: /\bdeepal\b|深蓝|深兰/i,                                label: '深蓝 / Deepal',        rec: ['deepal'], kind: 'exact' },
  { re: /avatr|阿维塔/i,                                        label: '阿维塔 / Avatr',       rec: ['avatr'], kind: 'exact' },
  { re: /\bxia\b|比亚迪夏|byd\s*xia/i,                           label: 'BYD 夏 / Xia MPV',     rec: ['byd-xia'], kind: 'exact' },

  // ===== 丰田系：有现成报价 =====
  { re: /corolla\s*cross|卡罗拉\s*cross|锐放|frontlander|雷凌/i, label: 'Toyota Corolla Cross/锐放', rec: ['toyota-corolla-cross', 'toyota-frontlander'], kind: 'exact' },
  { re: /corolla|卡罗拉/i,                                      label: 'Toyota Corolla',       rec: ['toyota-corolla'], kind: 'exact' },
  { re: /rav\s*4|rav4|荣放/i,                                   label: 'Toyota RAV4',          rec: ['toyota-rav4'], kind: 'exact' },
  { re: /camry|凯美瑞/i,                                        label: 'Toyota Camry',         rec: ['toyota-camry'], kind: 'exact' },
  { re: /elantra|伊兰特|领动/i,                                 label: 'Hyundai Elantra',      rec: ['hyundai-elantra'], kind: 'exact' },
  { re: /sportage|狮跑|智跑/i,                                  label: 'Kia Sportage',         rec: ['kia-sportage'], kind: 'exact' },

  // ===== 表外热门：原车能订货 + 转推现车替代 =====
  { re: /uni[\s-]?k|uni\s*k|unik/i,           label: 'Changan UNI-K',        rec: ['byd-song-l', 'byd-tang', 'byd-frigate-05'], kind: 'source', source: '长安 UNI-K（中型SUV，可订货）' },
  { re: /uni[\s-]?t|uni\s*t/i,                label: 'Changan UNI-T',        rec: ['byd-song-plus', 'byd-yuan-plus'], kind: 'source', source: '长安 UNI-T（紧凑SUV，可订货）' },
  { re: /cs\s*75|cs75/i,                      label: 'Changan CS75 Plus',    rec: ['byd-song-plus', 'byd-song-l'], kind: 'source', source: '长安 CS75 Plus（可订货）' },
  { re: /cs\s*55|cs55/i,                      label: 'Changan CS55',         rec: ['byd-song-pro', 'byd-song-plus'], kind: 'source', source: '长安 CS55（可订货）' },
  { re: /cs\s*35|cs35/i,                      label: 'Changan CS35',         rec: ['byd-yuan-plus', 'byd-yuan-up'], kind: 'source', source: '长安 CS35（可订货）' },
  { re: /hunter|猎手|changan.*pickup|长安.*皮卡/i, label: 'Changan Hunter 皮卡', rec: ['byd-bao-5'], kind: 'source', source: '长安 Hunter 皮卡（可订货）' },
  { re: /qiyuan|启源|q05|q07|deepal.*s07/i,   label: 'Changan Qiyuan 启源',  rec: ['byd-song-plus', 'deepal'], kind: 'source', source: '长安启源（可订货）' },
  { re: /\buni\b|changan|长安/i,              label: 'Changan 长安',         rec: ['byd-song-l', 'byd-song-plus'], kind: 'source', source: '长安（可订货）' },

  { re: /jetour.*t2|jetour\s*t-?2|\bt2\b|捷途.*t2|旅行者/i,  label: 'Jetour T2 旅行者',  rec: ['byd-bao-5', 'byd-frigate-05'], kind: 'source', source: '捷途 T2 旅行者（方盒子越野，可订货）' },
  { re: /jetour.*t1|\bt1\b/i,                 label: 'Jetour T1',            rec: ['byd-bao-5'], kind: 'source', source: '捷途 T1（可订货）' },
  { re: /x70|x90|jetour.*x|dashing|追风|capri|wandao|山海|emkoo|emi?co|G700/i, label: 'Jetour X系/Dashing', rec: ['byd-song-l', 'byd-tang', 'byd-song-plus'], kind: 'source', source: '捷途 X70/X90/Dashing（可订货）' },
  { re: /jetour|捷途/i,                       label: 'Jetour 捷途',          rec: ['byd-song-l', 'byd-bao-5'], kind: 'source', source: '捷途（可订货）' },

  { re: /rely\s*r0?8|r08|瑞虎9|tiggo\s*9|tiggo\s*8|瑞虎8/i,  label: 'Chery Tiggo/Rely (大SUV)', rec: ['byd-tang', 'byd-song-l'], kind: 'source', source: '奇瑞瑞虎8/9 / Rely（可订货）' },
  { re: /tiggo\s*7|瑞虎7|tiggo\s*5|tiggo\s*4|瑞虎4/i,  label: 'Chery Tiggo 4/5/7', rec: ['byd-song-plus', 'byd-yuan-plus'], kind: 'source', source: '奇瑞瑞虎4/5/7（可订货）' },
  { re: /chery|奇瑞|arrizo|艾瑞泽|omoda|jaecoo|exeed|星途/i, label: 'Chery 奇瑞', rec: ['byd-song-plus', 'byd-tang'], kind: 'source', source: '奇瑞系（可订货）' },

  { re: /hilux|海拉克斯|toyota.*pickup|fortuner|land\s*cruiser|prado|霸道|普拉多|lc\s*300/i, label: 'Toyota 越野/皮卡', rec: ['byd-bao-5', 'byd-bao-8'], kind: 'source', source: '丰田 Hilux/Prado/LC（可订货）' },
  { re: /hiace|海狮商务|coaster|考斯特/i,      label: 'Toyota 商务车',        rec: ['byd-xia'], kind: 'source', source: '丰田 Hiace/Coaster（可订货）' },
  { re: /toyota|丰田/i,                       label: 'Toyota 丰田',          rec: ['toyota-rav4', 'toyota-corolla'], kind: 'exact' },

  { re: /trumpchi|传祺|gs8|gs4|gs3|m8|e8|emkoo/i, label: 'GAC Trumpchi 传祺', rec: ['byd-tang', 'byd-song-plus'], kind: 'source', source: '广汽传祺 GS8/GS4/M8（可订货）' },
  { re: /geely|吉利|coolray|缤越|emgrand|帝豪|boyue|博越|starray|银河|galaxy|monjaro|星越/i, label: 'Geely 吉利', rec: ['byd-song-plus', 'byd-yuan-plus'], kind: 'source', source: '吉利系（可订货）' },
  { re: /gwm|长城|haval|哈弗|h6|tank\s*300|tank\s*500|坦克|poer|wingle|风骏|ora|欧拉/i, label: 'GWM 长城/坦克', rec: ['byd-bao-5', 'byd-song-l'], kind: 'source', source: '长城 Haval/坦克/皮卡（可订货）' },
  { re: /hongqi|红旗|hs5|hs7|h5|h9/i,         label: 'Hongqi 红旗',          rec: ['byd-han-dmi', 'byd-tang'], kind: 'source', source: '红旗系（可订货）' },
  { re: /honda|本田|crv|cr-v|civic|思域|accord|雅阁/i, label: 'Honda 本田', rec: ['toyota-rav4', 'byd-song-plus'], kind: 'source', source: '本田 CR-V/Civic（可订货）' },
  { re: /nissan|日产|x-?trail|奇骏|sylphy|轩逸|sunny/i, label: 'Nissan 日产', rec: ['byd-song-plus', 'toyota-corolla'], kind: 'source', source: '日产系（可订货）' },
  { re: /mg\b|名爵|mg\s*hs|mg\s*zs|roewe|荣威/i, label: 'MG / Roewe', rec: ['byd-yuan-plus', 'byd-song-plus'], kind: 'source', source: 'MG/荣威（可订货）' },
  { re: /\bbmw\b|宝马|benz|奔驰|mercedes|audi|奥迪|lexus|雷克萨斯|porsche|保时捷|land\s*rover|路虎/i, label: '豪华品牌', rec: ['byd-han-l-ev', 'byd-tang-l', 'byd-denza'], kind: 'source', source: '豪华品牌（BBA/雷克萨斯，可订货）' },
  { re: /leapmotor|零跑|xpeng|小鹏|nio|蔚来|zeekr|极氪|aito|问界|li\s*auto|理想|wuling|五菱|baojun|宝骏/i, label: '其它新势力', rec: ['deepal', 'byd-song-plus'], kind: 'source', source: '新势力（零跑/小鹏/极氪等，可订货）' },
]

// 段位泛化兜底：只说要"SUV / sedan / pickup / 7座 / EV / 便宜车"但没具体车型时
export const SEGMENT_RULES = [
  { re: /7\s*seat|七座|7座|family|big\s*suv|large\s*suv|seven\s*seat/i, label: '7座/大SUV需求', rec: ['byd-tang', 'byd-song-l'], kind: 'segment' },
  { re: /pick.?up|皮卡|truck|双排/i,           label: '皮卡需求',     rec: ['byd-bao-5', 'byd-bao-8'], kind: 'segment' },
  { re: /off.?road|越野|4wd|4x4|awd|four\s*wheel/i, label: '越野/四驱需求', rec: ['byd-bao-5', 'byd-tang-l'], kind: 'segment' },
  { re: /\bsuv\b|越野车/i,                     label: 'SUV需求',      rec: ['byd-song-plus', 'byd-yuan-plus', 'byd-song-l'], kind: 'segment' },
  { re: /sedan|轿车|saloon/i,                  label: '轿车需求',     rec: ['byd-qin-l-dmi', 'byd-han-dmi'], kind: 'segment' },
  { re: /\bev\b|electric|电动|纯电/i,          label: '纯电需求',     rec: ['byd-yuan-plus', 'byd-qin-plus-ev', 'byd-han-ev'], kind: 'segment' },
  { re: /hybrid|混动|phev|dm-?i/i,             label: '混动需求',     rec: ['byd-song-plus', 'toyota-corolla', 'byd-qin-l-dmi'], kind: 'segment' },
  { re: /cheap|budget|便宜|实惠|economic|affordable|low\s*price/i, label: '低价需求', rec: ['byd-yuan-up', 'byd-qin-plus-ev', 'hyundai-elantra'], kind: 'segment' },
  { re: /mpv|商务|7\s*seater|minivan|面包/i,   label: 'MPV/商务需求', rec: ['byd-xia', 'byd-tang'], kind: 'segment' },
]

// 港口 → 海运+保险估算（每台，USD，粗略，用户可改）
export const FREIGHT = {
  westAfrica: 1800, eastAfrica: 1900, southernAfrica: 2000, caribbean: 2200, latam: 2300,
  middleEast: 1600, pacific: 2600, southAsia: 1700, default: 2000,
}
export function freightFor(country) {
  const c = (country || '').toLowerCase()
  if (/ghana|togo|ivoire|ivory|nigeria|benin|guinea|cameroon|niger|burkina|mali|senegal|liberia|sierra|gambia/.test(c)) return ['westAfrica', FREIGHT.westAfrica]
  if (/kenya|tanzania|djibouti|uganda|rwanda|ethiopia|somalia|comoros|mombasa/.test(c)) return ['eastAfrica', FREIGHT.eastAfrica]
  if (/south africa|namibia|zambia|zimbabwe|mozambique|angola|congo/.test(c)) return ['southernAfrica', FREIGHT.southernAfrica]
  if (/dominic|trinidad|curacao|curaçao|jamaica|haiti|bahamas|barbados|sint maarten|guyana|suriname|aruba/.test(c)) return ['caribbean', FREIGHT.caribbean]
  if (/colombia|peru|bolivia|chile|venezuela|ecuador|paraguay|uruguay|panama|costa rica|guatemala|honduras|mexico|brazil|argentina/.test(c)) return ['latam', FREIGHT.latam]
  if (/iraq|iran|jordan|lebanon|syria|yemen|saudi|emirates|uae|oman|qatar|kuwait|bahrain/.test(c)) return ['middleEast', FREIGHT.middleEast]
  if (/vanuatu|fiji|samoa|tonga|papua|solomon|nauru/.test(c)) return ['pacific', FREIGHT.pacific]
  if (/nepal|bangladesh|pakistan|sri lanka|india|myanmar/.test(c)) return ['southAsia', FREIGHT.southAsia]
  return ['default', FREIGHT.default]
}
