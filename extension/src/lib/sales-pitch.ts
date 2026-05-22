/**
 * 检测消息是否是「营销话术 / 广告文案」而不是真正的客户对话内容。
 *
 * 两类场景都要识别：
 *   A. 销售（fromMe）发出的 Facebook 广告 / 群发模板 / 推广话术
 *      （"$X less than"、"X% off"、"save $X" 等对比促销）
 *   B. **Facebook lead form 系统消息**作为 inbound 进来，长得像客户发的但实际是 FB
 *      自动注入的广告文案（典型："logo-facebook-roundBYD QIN PLUS DMI Priced from $9000
 *      Calling all car dealers..."）。这种 inbound 会让 GLM 误抽成「客户预算」。
 *
 * 真实例子：
 *   销售侧 "Hi, check out the UNI-K Global - 15% more power and a panoramic roof for
 *          $11,000+ less than the Toyota RAV4!"
 *          → GPT-5 把 11000 当成客户 target
 *   FB lead 表单 inbound "logo-facebook-roundBYD QIN PLUS DMI Priced from $9000..."
 *          → GLM 把 9000 当成客户 budget
 *
 * 检测原则：宁可不报，不要错标真客户出价。必须满足比较/促销语义 + 数字。
 */
export function isSalesPitch(text: string): boolean {
  const t = text.trim();
  if (!t) return false;

  // 1. "$X less than" / "save $X" / "$X off" / "$X cheaper" / "$X savings"
  if (/\$\s*[\d,]+\+?\s*(less\s+than|off|cheaper|saving|saved?)/i.test(t)) return true;
  if (/save\s+(up\s+to\s+)?\$\s*[\d,]+/i.test(t)) return true;

  // 2. "X% less" / "X% off" / "X% more power|range|economy|cheaper"
  if (/\d+\s*%\s*(less|off|cheaper|more\s+(power|range|economy|economical|space|fuel|mileage|torque))/i.test(t)) {
    return true;
  }

  // 3. Facebook 广告气泡内文常见结构："check out the X for $Y" / "introducing the X"
  //    含品牌+价格+对比词，三者齐全才算
  if (/check\s+out\s+the/i.test(t) && /(\$|\d+\s*%)/.test(t) && /(less|off|cheaper|more|save)/i.test(t)) {
    return true;
  }

  // 4. "Limited time" / "this week only" + 价格 — 限时促销
  if (/(limited\s+time|this\s+(week|month)\s+only|special\s+offer|promo\s+price)/i.test(t) && /\$\s*[\d,]+/.test(t)) {
    return true;
  }

  // 5. Facebook lead form 系统注入消息（作为 inbound 出现）
  //    特征：含 "logo-facebook-round" 文字、"Priced from $X"、"Calling all X"
  if (/logo-facebook-round/i.test(t)) return true;
  if (/priced\s+from\s+\$\s*[\d,]+/i.test(t)) return true;
  if (/calling\s+all\s+(car\s+)?(dealers?|importers?|buyers?|customers?)/i.test(t)) return true;

  return false;
}
