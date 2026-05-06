export interface Region {
  id: string;
  name: string;
  emoji: string;
  countries: string[];
}

export const REGIONS: Region[] = [
  {
    id: 'pacific',
    name: '岛国',
    emoji: '🏝',
    countries: ['Vanuatu', 'Fiji', 'Solomon Islands', 'Samoa', 'Tonga', 'Papua New Guinea', 'Nauru', 'Kiribati', 'Palau', 'Timor-Leste', 'New Caledonia', 'French Polynesia'],
  },
  {
    id: 'east_africa',
    name: '东非',
    emoji: '🌴',
    countries: ['Kenya', 'Tanzania', 'Uganda', 'Ethiopia', 'Rwanda', 'Burundi', 'Somalia', 'Djibouti', 'Eritrea', 'South Sudan'],
  },
  {
    id: 'west_africa',
    name: '西非',
    emoji: '🌴',
    countries: ['Nigeria', 'Ghana', 'Senegal', "Côte d'Ivoire", 'Mali', 'Burkina Faso', 'Niger', 'Togo', 'Benin', 'Liberia', 'Sierra Leone', 'Guinea', 'Guinea-Bissau', 'Gambia', 'Mauritania', 'Cape Verde'],
  },
  {
    id: 'central_africa',
    name: '中非',
    emoji: '🌴',
    countries: ['DR Congo', 'Cameroon', 'Gabon', 'Republic of the Congo', 'Central African Republic', 'Chad', 'Equatorial Guinea', 'São Tomé and Príncipe'],
  },
  {
    id: 'southern_africa',
    name: '南部非洲',
    emoji: '🌴',
    countries: ['South Africa', 'Zimbabwe', 'Zambia', 'Mozambique', 'Namibia', 'Botswana', 'Angola', 'Malawi', 'Lesotho', 'Eswatini', 'Madagascar', 'Mauritius', 'Réunion', 'Comoros', 'Seychelles'],
  },
  {
    id: 'north_africa',
    name: '北非',
    emoji: '🏜',
    countries: ['Egypt', 'Morocco', 'Algeria', 'Tunisia', 'Libya', 'Sudan'],
  },
  {
    id: 'middle_east',
    name: '中东',
    emoji: '🏜',
    countries: ['UAE', 'Saudi Arabia', 'Iraq', 'Kuwait', 'Jordan', 'Lebanon', 'Syria', 'Yemen', 'Oman', 'Qatar', 'Bahrain', 'Israel', 'Palestine', 'Iran', 'Turkey'],
  },
  {
    id: 'south_asia',
    name: '南亚',
    emoji: '🏔',
    countries: ['India', 'Pakistan', 'Bangladesh', 'Sri Lanka', 'Nepal', 'Maldives', 'Afghanistan', 'Bhutan'],
  },
  {
    id: 'se_asia',
    name: '东南亚',
    emoji: '🌊',
    countries: ['Thailand', 'Vietnam', 'Indonesia', 'Malaysia', 'Philippines', 'Cambodia', 'Laos', 'Myanmar', 'Singapore', 'Brunei'],
  },
  {
    id: 'latin_america',
    name: '拉美',
    emoji: '🌎',
    countries: ['Mexico', 'Peru', 'Colombia', 'Bolivia', 'Chile', 'Brazil', 'Argentina', 'Ecuador', 'Venezuela', 'Paraguay', 'Uruguay', 'Guatemala', 'El Salvador', 'Honduras', 'Nicaragua', 'Costa Rica', 'Panama', 'Guyana', 'Suriname', 'French Guiana'],
  },
  {
    id: 'caribbean',
    name: '加勒比',
    emoji: '🏝',
    countries: ['Dominican Republic', 'Cuba', 'Haiti', 'Jamaica', 'Trinidad and Tobago', 'Barbados', 'Bahamas', 'Saint Lucia', 'Grenada', 'Dominica', 'Saint Vincent', 'Saint Kitts and Nevis', 'Antigua and Barbuda'],
  },
  {
    id: 'europe',
    name: '欧洲',
    emoji: '🇪🇺',
    countries: ['United Kingdom', 'Germany', 'France', 'Spain', 'Italy', 'Russia', 'Portugal', 'Netherlands', 'Belgium', 'Greece', 'Sweden', 'Norway', 'Denmark', 'Finland', 'Poland', 'Romania', 'Ukraine', 'Belarus', 'Czech Republic', 'Slovakia', 'Hungary', 'Austria', 'Switzerland', 'Ireland', 'Bulgaria', 'Croatia', 'Serbia', 'Bosnia and Herzegovina', 'Albania', 'North Macedonia', 'Moldova', 'Slovenia', 'Estonia', 'Latvia', 'Lithuania', 'Kosovo', 'Montenegro', 'Iceland', 'Malta', 'Cyprus', 'Luxembourg', 'Monaco', 'Andorra', 'San Marino', 'Liechtenstein'],
  },
  {
    id: 'oceania',
    name: '大洋洲',
    emoji: '🌏',
    countries: ['Australia', 'New Zealand'],
  },
  {
    id: 'central_asia',
    name: '中亚',
    emoji: '🏔',
    countries: ['Kazakhstan', 'Uzbekistan', 'Turkmenistan', 'Tajikistan', 'Kyrgyzstan', 'Mongolia', 'Azerbaijan', 'Georgia', 'Armenia'],
  },
  {
    id: 'other',
    name: '其他',
    emoji: '🌐',
    countries: [],
  },
];

const COUNTRY_TO_REGION = new Map<string, string>();
for (const r of REGIONS) {
  for (const c of r.countries) {
    COUNTRY_TO_REGION.set(c.toLowerCase(), r.id);
  }
}

export function countryToRegion(country: string | null | undefined): string {
  if (!country) return 'other';
  return COUNTRY_TO_REGION.get(country.toLowerCase()) ?? 'other';
}
