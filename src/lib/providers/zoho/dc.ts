/**
 * Zoho data centers. Accounts servers verified against https://accounts.zoho.com/oauth/serverinfo
 * and https://www.zoho.com/accounts/protocol/oauth/multi-dc.html.
 *
 * The CRM API domain is always taken from the `api_domain` returned in the token response;
 * the defaults below are fallbacks only. Marketing Automation regional hosts are NOT listed in
 * official docs (only marketingautomation.zoho.com is documented) — they are editable in
 * Integrations → Zoho Marketing Automation and flagged "unverified" in the UI.
 */
export interface ZohoDataCenter {
  key: string;
  label: string;
  accounts: string;
  apiDomain: string;
  apiDomainVerified: boolean;
  marketingAutomation: string;
  marketingAutomationVerified: boolean;
}

export const ZOHO_DATA_CENTERS: ZohoDataCenter[] = [
  { key: "com", label: "United States (zoho.com)", accounts: "https://accounts.zoho.com", apiDomain: "https://www.zohoapis.com", apiDomainVerified: true, marketingAutomation: "https://marketingautomation.zoho.com", marketingAutomationVerified: true },
  { key: "in", label: "India (zoho.in)", accounts: "https://accounts.zoho.in", apiDomain: "https://www.zohoapis.in", apiDomainVerified: false, marketingAutomation: "https://marketingautomation.zoho.in", marketingAutomationVerified: false },
  { key: "eu", label: "Europe (zoho.eu)", accounts: "https://accounts.zoho.eu", apiDomain: "https://www.zohoapis.eu", apiDomainVerified: true, marketingAutomation: "https://marketingautomation.zoho.eu", marketingAutomationVerified: false },
  { key: "uk", label: "United Kingdom (zoho.uk)", accounts: "https://accounts.zoho.uk", apiDomain: "https://www.zohoapis.uk", apiDomainVerified: false, marketingAutomation: "https://marketingautomation.zoho.uk", marketingAutomationVerified: false },
  { key: "com.au", label: "Australia (zoho.com.au)", accounts: "https://accounts.zoho.com.au", apiDomain: "https://www.zohoapis.com.au", apiDomainVerified: false, marketingAutomation: "https://marketingautomation.zoho.com.au", marketingAutomationVerified: false },
  { key: "jp", label: "Japan (zoho.jp)", accounts: "https://accounts.zoho.jp", apiDomain: "https://www.zohoapis.jp", apiDomainVerified: false, marketingAutomation: "https://marketingautomation.zoho.jp", marketingAutomationVerified: false },
  { key: "ca", label: "Canada (zohocloud.ca)", accounts: "https://accounts.zohocloud.ca", apiDomain: "https://www.zohoapis.ca", apiDomainVerified: false, marketingAutomation: "https://marketingautomation.zohocloud.ca", marketingAutomationVerified: false },
  { key: "sa", label: "Saudi Arabia (zoho.sa)", accounts: "https://accounts.zoho.sa", apiDomain: "https://www.zohoapis.sa", apiDomainVerified: false, marketingAutomation: "https://marketingautomation.zoho.sa", marketingAutomationVerified: false },
  { key: "com.cn", label: "China (zoho.com.cn)", accounts: "https://accounts.zoho.com.cn", apiDomain: "https://www.zohoapis.com.cn", apiDomainVerified: true, marketingAutomation: "https://marketingautomation.zoho.com.cn", marketingAutomationVerified: false },
];

export function getDataCenter(key: string | null | undefined): ZohoDataCenter {
  return ZOHO_DATA_CENTERS.find((d) => d.key === key) ?? ZOHO_DATA_CENTERS.find((d) => d.key === "in")!;
}

/** Only accept accounts-server values that belong to a known Zoho DC (prevents token exfiltration via redirect tampering). */
export function isTrustedAccountsServer(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ZOHO_DATA_CENTERS.some((d) => new URL(d.accounts).host === u.host);
  } catch {
    return false;
  }
}

export function isTrustedZohoApiDomain(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /^(www\.)?zohoapis\.[a-z.]+$/.test(u.host);
  } catch {
    return false;
  }
}

export const ZOHO_CRM_SCOPES = ["ZohoCRM.modules.contacts.READ", "ZohoCRM.coql.READ", "ZohoCRM.settings.fields.READ"];
export const ZOHO_MA_SCOPES = [
  "ZohoMarketingAutomation.campaign.ALL",
  "ZohoMarketingAutomation.lead.ALL",
];
