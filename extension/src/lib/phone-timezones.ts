/**
 * 客户当地时间显示。
 *
 * 思路：phone → country (复用 phone-countries.ts) → IANA timezone → 用 Intl.DateTimeFormat 格式化。
 *
 * 多时区国家（美/俄/加/澳/巴西/印尼等）只能挑一个最常见的：
 *   - 美国 → America/New_York（东部，国际生意默认）
 *   - 俄罗斯 → Europe/Moscow（首都/欧洲部分）
 *   - 加拿大 → America/Toronto
 *   - 澳大利亚 → Australia/Sydney
 *   - 巴西 → America/Sao_Paulo
 *   - 印尼 → Asia/Jakarta
 *   - 墨西哥 → America/Mexico_City
 *
 * 误差最多 ±3 小时（西海岸 vs 东海岸），对销售判断"现在能不能发消息"够用。
 */
import { phoneToCountry } from './phone-countries';

const COUNTRY_TIMEZONE: Record<string, string> = {
  // Africa
  Algeria: 'Africa/Algiers',
  Angola: 'Africa/Luanda',
  Benin: 'Africa/Porto-Novo',
  Botswana: 'Africa/Gaborone',
  'Burkina Faso': 'Africa/Ouagadougou',
  Burundi: 'Africa/Bujumbura',
  Cameroon: 'Africa/Douala',
  'Cape Verde': 'Atlantic/Cape_Verde',
  'Central African Republic': 'Africa/Bangui',
  Chad: 'Africa/Ndjamena',
  Comoros: 'Indian/Comoro',
  "Côte d'Ivoire": 'Africa/Abidjan',
  'DR Congo': 'Africa/Kinshasa',
  Djibouti: 'Africa/Djibouti',
  Egypt: 'Africa/Cairo',
  'Equatorial Guinea': 'Africa/Malabo',
  Eritrea: 'Africa/Asmara',
  Eswatini: 'Africa/Mbabane',
  Ethiopia: 'Africa/Addis_Ababa',
  Gabon: 'Africa/Libreville',
  Gambia: 'Africa/Banjul',
  Ghana: 'Africa/Accra',
  Guinea: 'Africa/Conakry',
  'Guinea-Bissau': 'Africa/Bissau',
  Kenya: 'Africa/Nairobi',
  Lesotho: 'Africa/Maseru',
  Liberia: 'Africa/Monrovia',
  Libya: 'Africa/Tripoli',
  Madagascar: 'Indian/Antananarivo',
  Malawi: 'Africa/Blantyre',
  Mali: 'Africa/Bamako',
  Mauritania: 'Africa/Nouakchott',
  Mauritius: 'Indian/Mauritius',
  Morocco: 'Africa/Casablanca',
  Mozambique: 'Africa/Maputo',
  Namibia: 'Africa/Windhoek',
  Niger: 'Africa/Niamey',
  Nigeria: 'Africa/Lagos',
  Réunion: 'Indian/Reunion',
  'Republic of the Congo': 'Africa/Brazzaville',
  Rwanda: 'Africa/Kigali',
  'São Tomé and Príncipe': 'Africa/Sao_Tome',
  Senegal: 'Africa/Dakar',
  Seychelles: 'Indian/Mahe',
  'Sierra Leone': 'Africa/Freetown',
  Somalia: 'Africa/Mogadishu',
  'South Africa': 'Africa/Johannesburg',
  'South Sudan': 'Africa/Juba',
  Sudan: 'Africa/Khartoum',
  Tanzania: 'Africa/Dar_es_Salaam',
  Togo: 'Africa/Lome',
  Tunisia: 'Africa/Tunis',
  Uganda: 'Africa/Kampala',
  Zambia: 'Africa/Lusaka',
  Zimbabwe: 'Africa/Harare',

  // Americas
  Anguilla: 'America/Anguilla',
  'Antigua and Barbuda': 'America/Antigua',
  Argentina: 'America/Argentina/Buenos_Aires',
  Bahamas: 'America/Nassau',
  Barbados: 'America/Barbados',
  Belize: 'America/Belize',
  Bermuda: 'Atlantic/Bermuda',
  Bolivia: 'America/La_Paz',
  Brazil: 'America/Sao_Paulo',
  'British Virgin Islands': 'America/Tortola',
  Canada: 'America/Toronto',
  'Cayman Islands': 'America/Cayman',
  Chile: 'America/Santiago',
  Colombia: 'America/Bogota',
  'Costa Rica': 'America/Costa_Rica',
  Cuba: 'America/Havana',
  Curaçao: 'America/Curacao',
  Dominica: 'America/Dominica',
  'Dominican Republic': 'America/Santo_Domingo',
  Ecuador: 'America/Guayaquil',
  'El Salvador': 'America/El_Salvador',
  'Falkland Islands': 'Atlantic/Stanley',
  'French Guiana': 'America/Cayenne',
  Grenada: 'America/Grenada',
  Guadeloupe: 'America/Guadeloupe',
  Guatemala: 'America/Guatemala',
  Guyana: 'America/Guyana',
  Haiti: 'America/Port-au-Prince',
  Honduras: 'America/Tegucigalpa',
  Jamaica: 'America/Jamaica',
  Martinique: 'America/Martinique',
  Mexico: 'America/Mexico_City',
  Montserrat: 'America/Montserrat',
  Nicaragua: 'America/Managua',
  Panama: 'America/Panama',
  Paraguay: 'America/Asuncion',
  Peru: 'America/Lima',
  'Puerto Rico': 'America/Puerto_Rico',
  'Saint Kitts and Nevis': 'America/St_Kitts',
  'Saint Lucia': 'America/St_Lucia',
  'Saint Vincent': 'America/St_Vincent',
  'Sint Maarten': 'America/Lower_Princes',
  Suriname: 'America/Paramaribo',
  'Trinidad and Tobago': 'America/Port_of_Spain',
  'Turks and Caicos': 'America/Grand_Turk',
  'US Virgin Islands': 'America/St_Thomas',
  'United States': 'America/New_York',
  Uruguay: 'America/Montevideo',
  Venezuela: 'America/Caracas',

  // Asia
  Afghanistan: 'Asia/Kabul',
  Armenia: 'Asia/Yerevan',
  Azerbaijan: 'Asia/Baku',
  Bahrain: 'Asia/Bahrain',
  Bangladesh: 'Asia/Dhaka',
  Bhutan: 'Asia/Thimphu',
  Brunei: 'Asia/Brunei',
  Cambodia: 'Asia/Phnom_Penh',
  China: 'Asia/Shanghai',
  Georgia: 'Asia/Tbilisi',
  'Hong Kong': 'Asia/Hong_Kong',
  India: 'Asia/Kolkata',
  Indonesia: 'Asia/Jakarta',
  Iran: 'Asia/Tehran',
  Iraq: 'Asia/Baghdad',
  Israel: 'Asia/Jerusalem',
  Japan: 'Asia/Tokyo',
  Jordan: 'Asia/Amman',
  Kuwait: 'Asia/Kuwait',
  Kyrgyzstan: 'Asia/Bishkek',
  Laos: 'Asia/Vientiane',
  Lebanon: 'Asia/Beirut',
  Macau: 'Asia/Macau',
  Malaysia: 'Asia/Kuala_Lumpur',
  Maldives: 'Indian/Maldives',
  Mongolia: 'Asia/Ulaanbaatar',
  Myanmar: 'Asia/Yangon',
  Nepal: 'Asia/Kathmandu',
  'North Korea': 'Asia/Pyongyang',
  Oman: 'Asia/Muscat',
  Pakistan: 'Asia/Karachi',
  Palestine: 'Asia/Gaza',
  Philippines: 'Asia/Manila',
  Qatar: 'Asia/Qatar',
  'Saudi Arabia': 'Asia/Riyadh',
  Singapore: 'Asia/Singapore',
  'South Korea': 'Asia/Seoul',
  'Sri Lanka': 'Asia/Colombo',
  Syria: 'Asia/Damascus',
  Taiwan: 'Asia/Taipei',
  Tajikistan: 'Asia/Dushanbe',
  Thailand: 'Asia/Bangkok',
  'Timor-Leste': 'Asia/Dili',
  Turkey: 'Europe/Istanbul',
  Turkmenistan: 'Asia/Ashgabat',
  UAE: 'Asia/Dubai',
  Uzbekistan: 'Asia/Tashkent',
  Vietnam: 'Asia/Ho_Chi_Minh',
  Yemen: 'Asia/Aden',

  // Europe
  Albania: 'Europe/Tirane',
  Andorra: 'Europe/Andorra',
  Austria: 'Europe/Vienna',
  Belarus: 'Europe/Minsk',
  Belgium: 'Europe/Brussels',
  'Bosnia and Herzegovina': 'Europe/Sarajevo',
  Bulgaria: 'Europe/Sofia',
  Croatia: 'Europe/Zagreb',
  Cyprus: 'Asia/Nicosia',
  'Czech Republic': 'Europe/Prague',
  Denmark: 'Europe/Copenhagen',
  Estonia: 'Europe/Tallinn',
  Finland: 'Europe/Helsinki',
  France: 'Europe/Paris',
  Germany: 'Europe/Berlin',
  Gibraltar: 'Europe/Gibraltar',
  Greece: 'Europe/Athens',
  Hungary: 'Europe/Budapest',
  Iceland: 'Atlantic/Reykjavik',
  Ireland: 'Europe/Dublin',
  Italy: 'Europe/Rome',
  Kosovo: 'Europe/Belgrade',
  Latvia: 'Europe/Riga',
  Liechtenstein: 'Europe/Vaduz',
  Lithuania: 'Europe/Vilnius',
  Luxembourg: 'Europe/Luxembourg',
  Malta: 'Europe/Malta',
  Moldova: 'Europe/Chisinau',
  Monaco: 'Europe/Monaco',
  Montenegro: 'Europe/Podgorica',
  Netherlands: 'Europe/Amsterdam',
  'North Macedonia': 'Europe/Skopje',
  Norway: 'Europe/Oslo',
  Poland: 'Europe/Warsaw',
  Portugal: 'Europe/Lisbon',
  Romania: 'Europe/Bucharest',
  Russia: 'Europe/Moscow',
  'San Marino': 'Europe/San_Marino',
  Serbia: 'Europe/Belgrade',
  Slovakia: 'Europe/Bratislava',
  Slovenia: 'Europe/Ljubljana',
  Spain: 'Europe/Madrid',
  Sweden: 'Europe/Stockholm',
  Switzerland: 'Europe/Zurich',
  Ukraine: 'Europe/Kyiv',
  'United Kingdom': 'Europe/London',

  // Oceania
  'American Samoa': 'Pacific/Pago_Pago',
  Australia: 'Australia/Sydney',
  Fiji: 'Pacific/Fiji',
  'French Polynesia': 'Pacific/Tahiti',
  Guam: 'Pacific/Guam',
  Kiribati: 'Pacific/Tarawa',
  Nauru: 'Pacific/Nauru',
  'New Caledonia': 'Pacific/Noumea',
  'New Zealand': 'Pacific/Auckland',
  'Norfolk Island': 'Pacific/Norfolk',
  'Northern Mariana Islands': 'Pacific/Saipan',
  Palau: 'Pacific/Palau',
  'Papua New Guinea': 'Pacific/Port_Moresby',
  Samoa: 'Pacific/Apia',
  'Solomon Islands': 'Pacific/Guadalcanal',
  Tonga: 'Pacific/Tongatapu',
  Vanuatu: 'Pacific/Efate',
};

export interface LocalTimeInfo {
  /** "14:23" */
  hhmm: string;
  /** UTC 偏移显示，如 "GMT+8" / "GMT-5" */
  offset: string;
  /** 国家名（用于 hover tooltip） */
  country: string;
  /** IANA tz id，调试用 */
  timezone: string;
  /** 0..23，用于判断早晚（晚 22 点后 / 早 7 点前飘灰） */
  hour: number;
}

/**
 * 给 country 名找 IANA 时区。命中不了返回 null。
 */
export function timezoneForCountry(country: string | null | undefined): string | null {
  if (!country) return null;
  return COUNTRY_TIMEZONE[country] ?? null;
}

/**
 * 给 phone 算客户当地时间。phone 要带 + 国际格式。
 *
 * @param phone 如 "+8613552592187"
 * @param now 当前时刻（默认 new Date()）
 */
export function localTimeForPhone(
  phone: string | null | undefined,
  now: Date = new Date(),
): LocalTimeInfo | null {
  if (!phone) return null;
  const country = phoneToCountry(phone);
  if (!country) return null;
  const tz = timezoneForCountry(country);
  if (!tz) return null;

  try {
    const fmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const hhmm = fmt.format(now);

    // hour（0..23）单独取，给晚上飘灰用
    const hourFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      hour12: false,
    });
    const hourStr = hourFmt.format(now);
    const hour = parseInt(hourStr, 10);

    // 偏移 "GMT+8"
    const offFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    });
    const parts = offFmt.formatToParts(now);
    const offset = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';

    return { hhmm, offset, country, timezone: tz, hour: isNaN(hour) ? 12 : hour };
  } catch {
    // Intl 不认识这个 tz id（理论不会，保险起见）
    return null;
  }
}
