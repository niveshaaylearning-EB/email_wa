/**
 * SIMULATED Marketing Cloud tenant (development and automated tests only).
 *
 * Implements the same wire protocol the real client uses — /v2/token, /v2/userinfo, SOAP
 * Retrieve with MoreDataAvailable/ContinueRequest paging (each continuation consumable
 * once), SOAP faults, and REST paging for journeys and Content Builder — so every archive
 * code path is exercised without a real account. All data is synthetic, deterministic and
 * labelled simulated wherever it is stored. Refused when NODE_ENV=production.
 *
 * Scenario highlights (mirrors the 18,000 vs ~16,000 investigation):
 *   DE "Q3_Research_Update_Audience": 18,000 rows = 17,953 distinct subscribers
 *   + 35 duplicate rows + 12 rows with a blank SubscriberKey.
 *   Job 4471203 targets it. Salesforce's own Send counters account for the gap in aggregate
 *   (Duplicates, MissingAddresses, ExistingUnsubscribes, ExistingUndeliverables,
 *   NumberExcluded), but only unsubscribed/held subscribers receive NotSentEvents — the
 *   1,3xx exclusion-list subscribers have no recipient-level evidence, as in real life.
 */
import { XMLParser } from "fast-xml-parser";
import { xmlEscape } from "./soap";

export const SIM_HOST = "https://sfmc.simulated/";
export const SIM_ENTERPRISE_MID = "510000001";
export const SIM_RESEARCH_MID = "510000002";
export const SIM_MAIN_JOB = "4471203";
export const SIM_MAIN_DE = "DE_Q3_AUDIENCE";

export interface SimOptions {
  pageSize?: number;
  /** Objects (or "DataExtensionObject[KEY]") that return "Insufficient privileges". */
  deny?: string[];
  /** Fail the Nth SOAP call (1-based) with the given condition, once. */
  failCall?: { n: number; kind: "429" | "500" | "auth" | "network" };
  /** Scale factor for the main audience (tests use small numbers). Default 1 = 18,000 rows. */
  scale?: number;
  invalidSecret?: string;
  /** Scopes returned in the token. */
  scopes?: string[];
}

// ─── Deterministic generators ─────────────────────────────────────────

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number, w = 6) => String(n).padStart(w, "0");
const subKey = (n: number) => `NIV${pad(n)}`;
const FIRST = ["Aarav", "Diya", "Kabir", "Meera", "Rohan", "Isha", "Vihaan", "Anaya", "Arjun", "Saanvi", "Reyansh", "Kiara"];
const RISK = ["Conservative", "Moderate", "Aggressive"];

/** SFMC-style wall-clock timestamp (no offset). */
function sfDate(base: number, offsetMs: number) {
  return new Date(base + offsetMs).toISOString().slice(0, 23);
}

type Row = Record<string, string>;

interface SimDataExtension {
  key: string;
  name: string;
  mid: string;
  folder: string;
  description: string;
  fields: { name: string; type: string; len?: string; pk?: boolean; req?: boolean }[];
  rows: () => Row[];
}

function subscriberStatus(n: number): string {
  if (n % 60 === 7) return "Unsubscribed";
  if (n % 71 === 3) return "Held";
  return "Active";
}
const onExclusionList = (n: number) => n % 13 === 5 && subscriberStatus(n) === "Active";

class SimTenant {
  readonly totalSubscribers: number;
  readonly mainAudience: number; // distinct valid subscribers in the main DE
  private cache = new Map<string, Row[]>();

  constructor(readonly opts: SimOptions) {
    const scale = opts.scale ?? 1;
    this.mainAudience = Math.max(60, Math.round(17_953 * scale));
    this.totalSubscribers = this.mainAudience + Math.max(40, Math.round(2_047 * scale));
  }

  private memo(key: string, build: () => Row[]): Row[] {
    let v = this.cache.get(key);
    if (!v) this.cache.set(key, (v = build()));
    return v;
  }

  dataExtensions(): SimDataExtension[] {
    const scale = this.opts.scale ?? 1;
    const dupCount = Math.max(3, Math.round(35 * scale));
    const blankCount = Math.max(2, Math.round(12 * scale));
    return [
      {
        key: SIM_MAIN_DE,
        name: "Q3_Research_Update_Audience",
        mid: SIM_RESEARCH_MID,
        folder: "201",
        description: "Audience for the Q3 research update email (state as of extraction, not necessarily send time)",
        fields: [
          { name: "SubscriberKey", type: "Text", len: "50", req: false },
          { name: "EmailAddress", type: "EmailAddress", len: "254" },
          { name: "FirstName", type: "Text", len: "50" },
          { name: "PortfolioCode", type: "Text", len: "10" },
          { name: "RiskProfile", type: "Text", len: "20" },
          { name: "OnboardedOn", type: "Date" },
        ],
        rows: () =>
          this.memo("de:main", () => {
            const r = rng(11);
            const rows: Row[] = [];
            for (let n = 1; n <= this.mainAudience; n++) rows.push(this.audienceRow(n, r));
            for (let i = 0; i < dupCount; i++) rows.splice(200 + i * 37, 0, { ...rows[100 + i * 53] });
            for (let i = 0; i < blankCount; i++) rows.splice(500 + i * 41, 0, { ...this.audienceRow(this.mainAudience + 1 + i, r), SubscriberKey: "" });
            return rows;
          }),
      },
      {
        key: "DE_CLIENT_MASTER",
        name: "Client_Master_Snapshot",
        mid: SIM_RESEARCH_MID,
        folder: "201",
        description: "Client master export used for research mailings",
        fields: [
          { name: "SubscriberKey", type: "Text", len: "50", pk: true, req: true },
          { name: "EmailAddress", type: "EmailAddress", len: "254" },
          { name: "ClientCode", type: "Text", len: "12" },
          { name: "AUM_Band", type: "Text", len: "20" },
          { name: "IsAdvisoryClient", type: "Boolean" },
          { name: "LastReviewed", type: "Date" },
        ],
        rows: () =>
          this.memo("de:master", () => {
            const r = rng(12);
            const count = Math.max(30, Math.round(5_200 * (this.opts.scale ?? 1)));
            return Array.from({ length: count }, (_, i) => ({
              SubscriberKey: subKey(i + 1),
              EmailAddress: `client${i + 1}@example.com`,
              ClientCode: `00${pad(i + 1, 7)}`,
              AUM_Band: ["<25L", "25L-1Cr", "1Cr-5Cr", ">5Cr"][Math.floor(r() * 4)],
              IsAdvisoryClient: r() > 0.4 ? "True" : "False",
              LastReviewed: `${2 + Math.floor(r() * 9)}/${1 + Math.floor(r() * 27)}/2026 12:00:00 AM`,
            }));
          }),
      },
      {
        key: "DE_WEBINAR_AUG",
        name: "Webinar_Registrations_Aug",
        mid: SIM_RESEARCH_MID,
        folder: "202",
        description: "Registrations for the August investor webinar",
        fields: [
          { name: "RegistrationID", type: "Number", pk: true, req: true },
          { name: "SubscriberKey", type: "Text", len: "50" },
          { name: "Mobile", type: "Phone" },
          { name: "Attended", type: "Boolean" },
        ],
        rows: () =>
          this.memo("de:webinar", () => {
            const r = rng(13);
            return Array.from({ length: Math.max(12, Math.round(640 * (this.opts.scale ?? 1))) }, (_, i) => ({
              RegistrationID: String(90000 + i),
              SubscriberKey: subKey(1 + Math.floor(r() * this.mainAudience)),
              Mobile: `+9198${pad(Math.floor(r() * 99999999), 8)}`,
              Attended: r() > 0.5 ? "True" : "False",
            }));
          }),
      },
      {
        key: "DE_COMPLIANCE_SUPPRESS",
        name: "Compliance_Exclusion_List",
        mid: SIM_RESEARCH_MID,
        folder: "203",
        description: "Exclusion list (current contents; membership at historical send times is not known)",
        fields: [{ name: "SubscriberKey", type: "Text", len: "50", pk: true, req: true }],
        rows: () =>
          this.memo("de:suppress", () => {
            const rows: Row[] = [];
            // Current state: includes most, but not all, historically excluded subscribers.
            for (let n = 1; n <= this.mainAudience; n++) if (onExclusionList(n) && n % 7 !== 0) rows.push({ SubscriberKey: subKey(n) });
            return rows;
          }),
      },
      {
        key: "DE_RESTRICTED",
        name: "Restricted_Finance_Extract",
        mid: SIM_RESEARCH_MID,
        folder: "203",
        description: "Rows not readable by the API user (simulates a permission gap)",
        fields: [{ name: "Id", type: "Text", len: "20", pk: true, req: true }],
        rows: () => [{ Id: "1" }],
      },
    ];
  }

  private audienceRow(n: number, r: () => number): Row {
    return {
      SubscriberKey: subKey(n),
      EmailAddress: `client${n}@example.com`,
      FirstName: FIRST[n % FIRST.length],
      PortfolioCode: `00${pad(Math.floor(r() * 9999), 4)}`,
      RiskProfile: RISK[n % 3],
      OnboardedOn: `${1 + (n % 12)}/${1 + (n % 27)}/2024 12:00:00 AM`,
    };
  }

  subscribers(): Row[] {
    return this.memo("subscribers", () =>
      Array.from({ length: this.totalSubscribers }, (_, i) => {
        const n = i + 1;
        const status = subscriberStatus(n);
        return {
          ID: String(70000000 + n),
          SubscriberKey: subKey(n),
          EmailAddress: `client${n}@example.com`,
          Status: status,
          CreatedDate: sfDate(Date.UTC(2023, 0, 1), n * 3_600_000),
          UnsubscribedDate: status === "Unsubscribed" ? sfDate(Date.UTC(2025, 2, 1), n * 60_000) : "",
          EmailTypePreference: "HTML",
        };
      }),
    );
  }

  /** Email jobs. `audience` = subscriber numbers targeted. */
  jobs() {
    const scale = this.opts.scale ?? 1;
    const small = (k: number) => Math.max(20, Math.round(k * scale));
    return [
      { id: SIM_MAIN_JOB, email: "88231", name: "Q3 Research Update", subject: "Your Q3 research update is here", sendDate: Date.UTC(2025, 8, 12, 4, 30), main: true, from: 1, to: this.mainAudience },
      { id: "4470110", email: "88190", name: "Monthly Market Outlook — Aug", subject: "Market outlook for August", sendDate: Date.UTC(2025, 7, 5, 4, 30), main: false, from: 1, to: small(5200) },
      { id: "4468951", email: "88102", name: "Webinar Invitation", subject: "Join our investor webinar", sendDate: Date.UTC(2025, 6, 18, 6, 0), main: false, from: 1, to: small(3100) },
      { id: "4472540", email: "88265", name: "Diwali Portfolio Note", subject: "Portfolio note: festive season", sendDate: Date.UTC(2025, 9, 15, 5, 0), main: false, from: 1, to: small(5200) },
      { id: "4475002", email: "88390", name: "Model Portfolio Rebalance Notice", subject: "Rebalance notice", sendDate: Date.UTC(2026, 1, 10, 5, 0), main: false, from: 1, to: small(2400) },
      // Older than the configured tracking retention window: Send metadata survives, events do not.
      { id: "4301877", email: "79011", name: "Annual Disclosure 2023", subject: "Annual disclosure document", sendDate: Date.UTC(2023, 5, 20, 5, 0), main: false, from: 1, to: small(4200) },
    ];
  }

  /** Who actually received a SentEvent for a job (excluding never-sent categories). */
  private sentSet(job: ReturnType<SimTenant["jobs"]>[number]): number[] {
    const out: number[] = [];
    for (let n = job.from; n <= job.to; n++) {
      if (subscriberStatus(n) !== "Active") continue;
      if (job.main && onExclusionList(n)) continue;
      out.push(n);
    }
    return out;
  }

  sendRow(job: ReturnType<SimTenant["jobs"]>[number]): Row {
    const sent = this.sentSet(job);
    let unsubs = 0;
    let held = 0;
    let excluded = 0;
    for (let n = job.from; n <= job.to; n++) {
      const st = subscriberStatus(n);
      if (st === "Unsubscribed") unsubs++;
      else if (st === "Held") held++;
      else if (job.main && onExclusionList(n)) excluded++;
    }
    const scale = this.opts.scale ?? 1;
    const dups = job.main ? Math.max(3, Math.round(35 * scale)) : 0;
    const blanks = job.main ? Math.max(2, Math.round(12 * scale)) : 0;
    const extras = job.main ? 14 : 0; // test seed list added at send time
    const events = this.trackingRows("SentEvent", job.id);
    const bounces = this.trackingRows("BounceEvent", job.id).length;
    const opens = new Set(this.trackingRows("OpenEvent", job.id).map((e) => e.SubscriberKey)).size;
    const clicks = new Set(this.trackingRows("ClickEvent", job.id).map((e) => e.SubscriberKey)).size;
    const old = job.sendDate < Date.now() - 730 * 86400_000;
    return {
      ID: job.id,
      "Client.ID": SIM_RESEARCH_MID,
      "Email.ID": job.email,
      EmailName: job.name,
      Subject: job.subject,
      FromName: "Niveshaay Research",
      FromAddress: "research@niveshaay.example",
      SendDate: sfDate(job.sendDate, -6 * 3_600_000),
      SentDate: sfDate(job.sendDate, -6 * 3_600_000 + 25 * 60_000),
      CreatedDate: sfDate(job.sendDate, -6 * 3_600_000 - 86_400_000),
      ModifiedDate: sfDate(job.sendDate, -6 * 3_600_000 + 26 * 60_000),
      Status: "Complete",
      IsAlwaysOn: "false",
      IsMultipart: "true",
      NumberTargeted: String(job.to - job.from + 1 + dups + blanks + extras),
      NumberSent: String(old ? sent.length + extras : events.length - (job.main ? 3 : 0)),
      NumberDelivered: String((old ? sent.length : events.length) - bounces),
      NumberErrored: "0",
      NumberExcluded: String(excluded),
      Duplicates: String(dups),
      InvalidAddresses: "0",
      ExistingUndeliverables: String(held),
      ExistingUnsubscribes: String(unsubs),
      MissingAddresses: String(blanks),
      HardBounces: String(Math.floor(bounces * 0.6)),
      SoftBounces: String(bounces - Math.floor(bounces * 0.6)),
      OtherBounces: "0",
      UniqueOpens: String(old ? Math.round(sent.length * 0.36) : opens),
      UniqueClicks: String(old ? Math.round(sent.length * 0.05) : clicks),
      Unsubscribes: String(this.trackingRows("UnsubEvent", job.id).length),
      ForwardedEmails: "0",
      "EmailSendDefinition.CustomerKey": `ESD_${job.id}`,
    };
  }

  /** Tracking events for one job. Jobs older than 730 days return nothing (retention). */
  trackingRows(objectType: string, jobId: string): Row[] {
    return this.memo(`trk:${objectType}:${jobId}`, () => {
      const job = this.jobs().find((j) => j.id === jobId);
      if (!job || job.sendDate < Date.now() - 730 * 86400_000) return [];
      const base = job.sendDate - 6 * 3_600_000;
      const r = rng(Number(jobId) % 100000);
      const sent = this.sentSet(job);
      const common = (n: number, offset: number, type: string): Row => ({
        SendID: jobId,
        SubscriberKey: subKey(n),
        EventDate: sfDate(base, offset),
        EventType: type,
        BatchID: String(1 + Math.floor(n / 2500)),
        ListID: job.main ? "9001" : "9002",
        TriggeredSendDefinitionObjectID: "",
        PartnerKey: "",
        "Client.ID": SIM_RESEARCH_MID,
      });
      switch (objectType) {
        case "SentEvent": {
          const rows = sent.map((n) => common(n, 60_000 + n * 70, "Sent"));
          if (job.main) {
            for (let i = 0; i < 14; i++) rows.push(common(900_000 + i, 50_000, "Sent")); // seed list, not in DE
            for (let i = 0; i < 3; i++) {
              const at = (37 + i * 97) % rows.length; // duplicate rows, as Salesforce occasionally returns
              rows.splice(at, 0, { ...rows[at] });
            }
          }
          return rows;
        }
        case "NotSentEvent": {
          const rows: Row[] = [];
          for (let n = job.from; n <= job.to; n++) {
            const st = subscriberStatus(n);
            if (st !== "Active") rows.push(common(n, 30_000, st === "Unsubscribed" ? "NotSent:Unsubscribed" : "NotSent:Held"));
          }
          return rows;
        }
        case "BounceEvent":
          return sent
            .filter(() => r() < 0.008)
            .map((n) => ({
              ...common(n, 90_000 + n * 75, "HardBounce"),
              BounceCategory: r() < 0.6 ? "Hard bounce" : "Soft bounce",
              BounceType: "immediate",
              SMTPCode: r() < 0.6 ? "550" : "452",
              SMTPReason: "Mailbox unavailable",
            }));
        case "OpenEvent": {
          const rows: Row[] = [];
          for (const n of sent) {
            if (r() < 0.37) {
              const times = 1 + Math.floor(r() * 3);
              for (let t = 0; t < times; t++) rows.push(common(n, 3_600_000 + Math.floor(r() * 5 * 86_400_000), "Open"));
            }
          }
          return rows;
        }
        case "ClickEvent": {
          const rows: Row[] = [];
          for (const n of sent) {
            if (r() < 0.055) {
              rows.push({ ...common(n, 4_000_000 + Math.floor(r() * 4 * 86_400_000), "Click"), URL: "https://www.niveshaay.com/research/q3", URLID: "301" });
              if (r() < 0.3) rows.push({ ...common(n, 4_100_000 + Math.floor(r() * 4 * 86_400_000), "Click"), URL: "https://www.niveshaay.com/disclosures", URLID: "302" });
            }
          }
          return rows;
        }
        case "UnsubEvent":
          return sent.filter(() => r() < 0.003).map((n) => common(n, 7_200_000 + n * 50, "Unsubscribe"));
        default:
          return [];
      }
    });
  }

  rowsFor(objectType: string, props: string[]): { rows: Row[]; allowed: Set<string> } | { error: string } {
    const de = /^DataExtensionObject\[(.+)\]$/.exec(objectType);
    if (de) {
      const def = this.dataExtensions().find((d) => d.key === de[1]);
      if (!def) return { error: `Error: Unable to find DataExtension with CustomerKey ${de[1]}` };
      return { rows: def.rows(), allowed: new Set(def.fields.map((f) => f.name)) };
    }
    const flat = (rows: Row[]) => ({ rows, allowed: new Set(rows.length ? Object.keys(rows[0]) : props) });
    switch (objectType) {
      case "BusinessUnit":
        return {
          rows: [
            { ID: SIM_ENTERPRISE_MID, Name: "Niveshaay (Enterprise) — SIMULATED", ParentID: "0", CustomerKey: "NIV_ENT", Description: "Enterprise account", CreatedDate: "2021-04-01T09:00:00", ModifiedDate: "2025-01-10T09:00:00" },
            { ID: SIM_RESEARCH_MID, Name: "Niveshaay Research — SIMULATED", ParentID: SIM_ENTERPRISE_MID, CustomerKey: "NIV_RES", Description: "Research communications", CreatedDate: "2021-04-01T09:00:00", ModifiedDate: "2025-01-10T09:00:00" },
          ],
          allowed: new Set(["ID", "Name", "ParentID", "CustomerKey", "Description", "CreatedDate", "ModifiedDate"]),
        };
      case "DataFolder":
        return flat([
          { ID: "200", Name: "Data Extensions", "ParentFolder.ID": "0", ContentType: "dataextension", CustomerKey: "", Description: "", CreatedDate: "2021-04-01T09:00:00", ModifiedDate: "2021-04-01T09:00:00" },
          { ID: "201", Name: "Research Audiences", "ParentFolder.ID": "200", ContentType: "dataextension", CustomerKey: "", Description: "", CreatedDate: "2022-02-01T09:00:00", ModifiedDate: "2025-08-01T09:00:00" },
          { ID: "202", Name: "Events", "ParentFolder.ID": "200", ContentType: "dataextension", CustomerKey: "", Description: "", CreatedDate: "2022-02-01T09:00:00", ModifiedDate: "2025-08-01T09:00:00" },
          { ID: "203", Name: "Compliance", "ParentFolder.ID": "200", ContentType: "dataextension", CustomerKey: "", Description: "", CreatedDate: "2022-02-01T09:00:00", ModifiedDate: "2025-08-01T09:00:00" },
        ]);
      case "DataExtension":
        return flat(
          this.dataExtensions().map((d, i) => ({
            ObjectID: `de-obj-${i + 1}-0000-4000-8000-00000000000${i}`,
            CustomerKey: d.key,
            Name: d.name,
            Description: d.description,
            CategoryID: d.folder,
            CreatedDate: "2025-07-01T10:00:00.000",
            ModifiedDate: "2025-09-11T18:20:00.000",
            IsSendable: d.key === SIM_MAIN_DE || d.key === "DE_CLIENT_MASTER" ? "true" : "false",
            IsTestable: "false",
            "SendableDataExtensionField.Name": d.key === SIM_MAIN_DE || d.key === "DE_CLIENT_MASTER" ? "SubscriberKey" : "",
            "SendableSubscriberField.Name": d.key === SIM_MAIN_DE || d.key === "DE_CLIENT_MASTER" ? "Subscriber Key" : "",
            DataRetentionPeriodLength: d.key === "DE_WEBINAR_AUG" ? "6" : "",
            DataRetentionPeriod: d.key === "DE_WEBINAR_AUG" ? "Months" : "",
            RowBasedRetention: "false",
            ResetRetentionPeriodOnImport: "false",
            DeleteAtEndOfRetentionPeriod: "false",
            RetainUntil: "",
            "Client.ID": d.mid,
          })),
        );
      case "DataExtensionField": {
        const rows: Row[] = [];
        for (const d of this.dataExtensions())
          d.fields.forEach((f, i) =>
            rows.push({
              ObjectID: `${d.key}-f${i}`,
              CustomerKey: `[${d.key}].[${f.name}]`,
              Name: f.name,
              FieldType: f.type,
              MaxLength: f.len ?? "",
              Scale: f.type === "Decimal" ? "2" : "0",
              IsPrimaryKey: f.pk ? "true" : "false",
              IsRequired: f.req ? "true" : "false",
              Ordinal: String(i),
              DefaultValue: "",
              "DataExtension.CustomerKey": d.key,
            }),
          );
        return flat(rows);
      }
      case "Subscriber":
        return flat(this.subscribers());
      case "List":
        return flat([
          { ID: "9001", ListName: "All Subscribers", Description: "", Type: "Public", ListClassification: "ExactTargetList", CreatedDate: "2021-04-01T09:00:00", ModifiedDate: "2025-01-01T09:00:00", Category: "100" },
          { ID: "9002", ListName: "Research Seed List", Description: "Internal reviewers", Type: "Private", ListClassification: "ExactTargetList", CreatedDate: "2022-04-01T09:00:00", ModifiedDate: "2025-01-01T09:00:00", Category: "100" },
        ]);
      case "Send":
        return { rows: this.jobs().map((j) => this.sendRow(j)), allowed: new Set(Object.keys(this.sendRow(this.jobs()[0]))) };
      case "Email": {
        // One email per job; the 2023 email was deleted (not returned); the main email was edited after its send.
        const rows = this.jobs()
          .filter((j) => j.email !== "79011")
          .map((j) => ({
            ID: j.email,
            Name: j.name,
            Subject: j.subject,
            PreHeader: `${j.name} preheader`,
            HTMLBody: `<html><body><img src="https://image.s10.sfmc-content.com/lib/abc/logo.png"><h1>${j.name}</h1><p>Dear %%FirstName%%,</p><img src="https://image.s10.sfmc-content.com/lib/abc/chart.png"></body></html>`,
            TextBody: `${j.name}\nDear %%FirstName%%,`,
            EmailType: "HTML",
            CategoryID: "100",
            CharacterSet: "utf-8",
            IsHTMLPaste: "true",
            Status: "Active",
            CreatedDate: sfDate(j.sendDate, -10 * 86_400_000),
            ModifiedDate: sfDate(j.sendDate, j.main ? 3 * 86_400_000 : -86_400_000),
          }));
        return flat(rows);
      }
      case "TriggeredSendDefinition":
        return flat([
          { ObjectID: "tsd-1", CustomerKey: "TSD_WELCOME", Name: "Welcome Journey Email", Description: "", TriggeredSendStatus: "Active", "Email.ID": "87001", "SendClassification.CustomerKey": "Commercial", CreatedDate: "2024-01-05T09:00:00", ModifiedDate: "2025-05-05T09:00:00", CategoryID: "300" },
        ]);
      case "SentEvent":
      case "OpenEvent":
      case "ClickEvent":
      case "BounceEvent":
      case "UnsubEvent":
      case "NotSentEvent": {
        const rows = this.jobs().flatMap((j) => this.trackingRows(objectType, j.id));
        const base = ["SendID", "SubscriberKey", "EventDate", "EventType", "BatchID", "ListID", "TriggeredSendDefinitionObjectID", "PartnerKey", "Client.ID"];
        const extra = objectType === "ClickEvent" ? ["URL", "URLID"] : objectType === "BounceEvent" ? ["BounceCategory", "BounceType", "SMTPCode", "SMTPReason"] : [];
        return { rows, allowed: new Set([...base, ...extra]) };
      }
      case "Automation":
        return flat([
          { ObjectID: "auto-1", CustomerKey: "AUTO_DAILY_SYNC", Name: "Daily CRM sync to audience DEs", Description: "Imports CRM extract and refreshes research audiences", Status: "2", CreatedDate: "2023-03-01T09:00:00", ModifiedDate: "2025-09-01T09:00:00", ScheduledTime: "2025-10-01T02:00:00", LastRunTime: "2025-10-15T02:00:00", AutomationType: "scheduled", CategoryID: "400", IsActive: "true" },
          { ObjectID: "auto-2", CustomerKey: "AUTO_SUPPRESS", Name: "Build compliance exclusion list", Description: "", Status: "2", CreatedDate: "2024-01-15T09:00:00", ModifiedDate: "2025-08-20T09:00:00", ScheduledTime: "2025-10-01T03:00:00", LastRunTime: "2025-10-15T03:00:00", AutomationType: "scheduled", CategoryID: "400", IsActive: "true" },
          { ObjectID: "auto-3", CustomerKey: "AUTO_LEGACY", Name: "Legacy newsletter import", Description: "", Status: "0", CreatedDate: "2022-01-15T09:00:00", ModifiedDate: "2023-08-20T09:00:00", ScheduledTime: "", LastRunTime: "2023-08-20T03:00:00", AutomationType: "triggered", CategoryID: "400", IsActive: "false" },
        ]);
      case "QueryDefinition":
        return flat([
          { ObjectID: "qd-1", CustomerKey: "Q_BUILD_Q3", Name: "Build Q3 audience", Description: "", QueryText: "SELECT SubscriberKey, EmailAddress, FirstName FROM Client_Master_Snapshot WHERE IsAdvisoryClient = 1", TargetType: "DE", "DataExtensionTarget.Name": "Q3_Research_Update_Audience", "DataExtensionTarget.CustomerKey": SIM_MAIN_DE, TargetUpdateType: "Overwrite", CategoryID: "401", CreatedDate: "2025-07-01T09:00:00", ModifiedDate: "2025-09-10T09:00:00" },
          { ObjectID: "qd-2", CustomerKey: "Q_SUPPRESS", Name: "Exclusion list from complaints", Description: "", QueryText: "SELECT s.SubscriberKey FROM _Subscribers s WHERE s.Status = 'held'", TargetType: "DE", "DataExtensionTarget.Name": "Compliance_Exclusion_List", "DataExtensionTarget.CustomerKey": "DE_COMPLIANCE_SUPPRESS", TargetUpdateType: "Overwrite", CategoryID: "401", CreatedDate: "2024-01-15T09:00:00", ModifiedDate: "2025-08-20T09:00:00" },
        ]);
      default:
        return { error: `Error: Unknown object type ${objectType}` };
    }
  }
}

// ─── Filter evaluation ────────────────────────────────────────────────

type ParsedFilter = Record<string, unknown>;
function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}
function evalFilter(f: ParsedFilter | undefined, row: Row): boolean {
  if (!f) return true;
  if (f.LeftOperand) {
    const l = evalFilter(f.LeftOperand as ParsedFilter, row);
    const r = evalFilter(f.RightOperand as ParsedFilter, row);
    return String(f.LogicalOperator).toUpperCase() === "AND" ? l && r : l || r;
  }
  const prop = String(f.Property);
  const v = row[prop] ?? "";
  const vals = asArray(f.Value as string | string[]).map(String);
  const dates = asArray(f.DateValue as string | string[]).map(String);
  const cmp = dates.length ? dates : vals;
  switch (String(f.SimpleOperator)) {
    case "equals":
      return v === cmp[0];
    case "notEquals":
      return v !== cmp[0];
    case "IN":
      return cmp.includes(v);
    case "greaterThan":
      return v > cmp[0];
    case "lessThan":
      return v < cmp[0];
    case "greaterThanOrEqual":
      return v >= cmp[0];
    case "lessThanOrEqual":
      return v <= cmp[0];
    case "between":
      return v >= cmp[0] && v <= cmp[1];
    case "like":
      return v.includes(cmp[0].replace(/%/g, ""));
    case "isNull":
      return v === "";
    case "isNotNull":
      return v !== "";
    default:
      return true;
  }
}

function resultXml(objectType: string, row: Row, props: string[]): string {
  if (objectType.startsWith("DataExtensionObject[")) {
    const ps = props.map((p) => `<Property><Name>${xmlEscape(p)}</Name><Value>${xmlEscape(row[p] ?? "")}</Value></Property>`).join("");
    return `<Results xsi:type="DataExtensionObject"><PartnerKey xsi:nil="true"/><ObjectID xsi:nil="true"/><Type>DataExtensionObject</Type><Properties>${ps}</Properties></Results>`;
  }
  // Build nested XML from dot-separated property names ("Email.ID" → <Email><ID>…)
  const tree: Record<string, unknown> = {};
  for (const p of props) {
    const parts = p.split(".");
    let cur = tree;
    parts.slice(0, -1).forEach((k) => (cur = (cur[k] ??= {}) as Record<string, unknown>));
    cur[parts[parts.length - 1]] = row[p] ?? "";
  }
  const render = (o: Record<string, unknown>): string =>
    Object.entries(o)
      .map(([k, v]) => (typeof v === "object" ? `<${k}>${render(v as Record<string, unknown>)}</${k}>` : v === "" ? `<${k} />` : `<${k}>${xmlEscape(String(v))}</${k}>`))
      .join("");
  return `<Results xsi:type="${xmlEscape(objectType)}">${render(tree)}</Results>`;
}

function soapResponse(overall: string, requestId: string, results: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soap:Body><RetrieveResponseMsg xmlns="http://exacttarget.com/wsdl/partnerAPI"><OverallStatus>${xmlEscape(overall)}</OverallStatus><RequestID>${requestId}</RequestID>${results}</RetrieveResponseMsg></soap:Body></soap:Envelope>`;
}
function soapFault(msg: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Client</faultcode><faultstring>${xmlEscape(msg)}</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
}

const reqParser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false, isArray: (n) => n === "Properties" || n === "Value" || n === "DateValue" });

// ─── Fetch implementation ─────────────────────────────────────────────

export function createSimulatedFetch(opts: SimOptions = {}): typeof fetch & { calls: { channel: string; detail: string }[] } {
  const tenant = new SimTenant(opts);
  const pageSize = opts.pageSize ?? 2500;
  const continuations = new Map<string, { objectType: string; props: string[]; rows: Row[]; offset: number; used: boolean }>();
  let soapCalls = 0;
  let tokenSeq = 0;
  const calls: { channel: string; detail: string }[] = [];
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const impl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    if (url.hostname.endsWith(".sfmc-content.com")) {
      // Published content files (public CDN). The chart image is missing to exercise the gap path.
      calls.push({ channel: "file", detail: url.pathname });
      if (url.pathname.endsWith("logo.png")) return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]), { status: 200, headers: { "content-type": "image/png" } });
      return new Response("Not Found", { status: 404 });
    }
    if (url.origin !== new URL(SIM_HOST).origin) throw new TypeError(`Simulator received request for unexpected host ${url.host}`);
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.pathname;

    if (path === "/v2/token" && method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, string>;
      calls.push({ channel: "auth", detail: `token mid=${body.account_id ?? "home"}` });
      if (body.grant_type !== "client_credentials" || !body.client_id || !body.client_secret || body.client_secret === (opts.invalidSecret ?? "invalid-secret")) {
        return json(401, { error: "invalid_client", error_description: "Client authentication failed." });
      }
      if (body.account_id && ![SIM_ENTERPRISE_MID, SIM_RESEARCH_MID].includes(body.account_id)) {
        return json(401, { error: "unauthorized_client", error_description: "The client is not authorized for the requested account_id." });
      }
      tokenSeq += 1;
      return json(200, {
        access_token: `sim-token-${tokenSeq}-${body.account_id ?? "home"}`,
        token_type: "Bearer",
        expires_in: 1080,
        scope: (opts.scopes ?? ["data_extensions_read", "email_read", "tracking_events_read", "list_and_subscribers_read", "journeys_read", "automations_read", "saved_content_read", "accounts_read"]).join(" "),
        soap_instance_url: SIM_HOST,
        rest_instance_url: SIM_HOST,
      });
    }

    const auth = String((init.headers as Record<string, string> | undefined)?.Authorization ?? "");
    if (path === "/v2/userinfo") {
      if (!auth.startsWith("Bearer sim-token")) return json(401, { message: "Not authorized" });
      return json(200, {
        exp: Math.floor(Date.now() / 1000) + 1080,
        organization: { member_id: auth.includes(SIM_ENTERPRISE_MID) ? Number(SIM_ENTERPRISE_MID) : Number(SIM_RESEARCH_MID), enterprise_id: Number(SIM_ENTERPRISE_MID), enterprise_name: "Niveshaay (SIMULATED)", account_type: "ENTERPRISE_2", stack_key: "SIM", region: "SIM" },
        rest: { rest_instance_url: SIM_HOST, soap_instance_url: SIM_HOST },
        application: { id: "sim-app", name: "Niveshaay Archive (SIMULATED)" },
      });
    }

    if (path === "/Service.asmx" && method === "POST") {
      soapCalls += 1;
      const body = String(init.body ?? "");
      const token = /<fueloauth[^>]*>([^<]+)<\/fueloauth>/.exec(body)?.[1] ?? "";
      if (opts.failCall && opts.failCall.n === soapCalls) {
        const k = opts.failCall.kind;
        calls.push({ channel: "soap", detail: `injected ${k}` });
        if (k === "network") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
        if (k === "429") return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "0" } });
        if (k === "500") return new Response(soapFault("Server unavailable"), { status: 500 });
        if (k === "auth") return new Response(soapFault("Login failed: Token Expired"), { status: 500 });
      }
      if (!token.startsWith("sim-token")) return new Response(soapFault("Login failed"), { status: 500 });
      const doc = reqParser.parse(body) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      const rr = doc?.Envelope?.Body?.RetrieveRequestMsg?.RetrieveRequest ?? {};
      const reqId = `sim-req-${soapCalls}`;
      if (rr.ContinueRequest) {
        const c = continuations.get(String(rr.ContinueRequest));
        calls.push({ channel: "soap", detail: `continue ${c?.objectType ?? "?"}` });
        if (!c || c.used) return new Response(soapResponse("Error: The ContinueRequest RequestID is invalid or expired", reqId, ""), { status: 200 });
        c.used = true;
        return pageResponse(c.objectType, c.props, c.rows, c.offset, reqId);
      }
      const objectType = String(rr.ObjectType ?? "");
      const props = asArray<string>(rr.Properties).map(String);
      calls.push({ channel: "soap", detail: `retrieve ${objectType}` });
      const deny = opts.deny ?? ["DataExtensionObject[DE_RESTRICTED]"];
      if (deny.includes(objectType)) return new Response(soapResponse("Error: Insufficient privileges to retrieve " + objectType, reqId, ""), { status: 200 });
      const src = tenant.rowsFor(objectType, props);
      if ("error" in src) return new Response(soapResponse(src.error, reqId, ""), { status: 200 });
      const unknown = props.filter((p) => !src.allowed.has(p));
      if (unknown.length) {
        return new Response(soapResponse(`Error: The Request Property(s) ${unknown.join(", ")} do not match with the fields of ${objectType} retrieve`, reqId, ""), { status: 200 });
      }
      const rows = src.rows.filter((row) => evalFilter(rr.Filter as ParsedFilter | undefined, row));
      return pageResponse(objectType, props, rows, 0, reqId);
    }

    const rowset = /^\/data\/v1\/customobjectdata\/key\/([^/]+)\/rowset\/?$/.exec(path);
    if (method === "GET" && rowset) {
      const key = decodeURIComponent(rowset[1]);
      calls.push({ channel: "rest", detail: `rowset ${key}` });
      if (!auth.startsWith("Bearer sim-token")) return json(401, { message: "Not Authorized", errorcode: 1 });
      if ((opts.deny ?? ["DataExtensionObject[DE_RESTRICTED]"]).includes(`DataExtensionObject[${key}]`)) return json(403, { message: "Insufficient privileges", errorcode: 10003 });
      const def = tenant.dataExtensions().find((d) => d.key === key);
      if (!def) return json(404, { message: "Data Extension not found", errorcode: 10000 });
      const page = Number(url.searchParams.get("$page") ?? 1);
      const size = Number(url.searchParams.get("$pageSize") ?? 2500);
      const rows = def.rows();
      // Real rowset responses lower-case field names and split primary-key fields into `keys`.
      const items = rows.slice((page - 1) * size, page * size).map((r) => {
        const keys: Record<string, string> = {};
        const values: Record<string, string> = {};
        for (const f of def.fields) (f.pk ? keys : values)[f.name.toLowerCase()] = r[f.name] ?? "";
        return { keys, values };
      });
      return json(200, { links: {}, requestToken: "sim", customObjectKey: key, pageSize: size, page, count: rows.length, top: 0, items });
    }
    if (method === "GET" && path.startsWith("/interaction/v1/interactions")) {
      calls.push({ channel: "rest", detail: path });
      if (!auth.startsWith("Bearer sim-token")) return json(401, { message: "Not Authorized", errorcode: 1 });
      const page = Number(url.searchParams.get("$page") ?? 1);
      const size = Number(url.searchParams.get("$pageSize") ?? 50);
      const all = simJourneys();
      return json(200, { count: all.length, page, pageSize: size, items: all.slice((page - 1) * size, page * size) });
    }
    if (method === "GET" && (path === "/asset/v1/content/assets" || path === "/asset/v1/content/categories")) {
      calls.push({ channel: "rest", detail: path });
      if (!auth.startsWith("Bearer sim-token")) return json(401, { message: "Not Authorized", errorcode: 1 });
      const page = Number(url.searchParams.get("$page") ?? 1);
      const size = Number(url.searchParams.get("$pagesize") ?? 50);
      const all = path.endsWith("categories") ? simCategories() : simAssets();
      return json(200, { count: all.length, page, pageSize: size, items: all.slice((page - 1) * size, page * size) });
    }
    return json(404, { message: `Simulator: no route for ${method} ${path}` });

    function pageResponse(objectType: string, props: string[], rows: Row[], offset: number, reqId: string): Response {
      const slice = rows.slice(offset, offset + pageSize);
      const more = offset + pageSize < rows.length;
      if (more) continuations.set(reqId, { objectType, props, rows, offset: offset + pageSize, used: false });
      return new Response(soapResponse(more ? "MoreDataAvailable" : "OK", reqId, slice.map((r) => resultXml(objectType, r, props)).join("")), {
        status: 200,
        headers: { "content-type": "text/xml" },
      });
    }
  };
  return Object.assign(impl as typeof fetch, { calls });
}

function simJourneys() {
  const mk = (id: string, key: string, name: string, version: number, status: string, mod: string) => ({
    id,
    key,
    name,
    version,
    status,
    definitionType: "Multistep",
    createdDate: "2024-02-01T10:00:00",
    modifiedDate: mod,
    entryMode: "SingleEntryAcrossAllVersions",
    triggers: [{ key: "TRIGGER", type: "AutomationAudience", eventDefinitionKey: "DEAudience-q3", configurationArguments: { dataExtensionId: "de-obj-1" } }],
    activities: [
      { key: "EMAILV2-1", type: "EMAILV2", name: "Q3 Research Update", configurationArguments: { triggeredSend: { emailId: 88231, triggeredSendKey: "TSD_Q3" } } },
      { key: "WAIT-1", type: "WAIT", name: "Wait 2 days", configurationArguments: { waitDuration: 2, waitUnit: "DAYS" } },
    ],
    stats: { currentPopulation: 0, cumulativePopulation: 16000 },
  });
  return [
    mk("jrn-1111-aaaa", "Q3_RESEARCH", "Q3 Research Journey", 1, "Stopped", "2025-08-01T10:00:00"),
    mk("jrn-1111-aaaa", "Q3_RESEARCH", "Q3 Research Journey", 2, "Finished", "2025-09-12T10:00:00"),
    mk("jrn-2222-bbbb", "WELCOME", "Client Welcome Journey", 4, "Published", "2025-05-05T10:00:00"),
    mk("jrn-3333-cccc", "WEBINAR", "Webinar Reminder Journey", 1, "Draft", "2025-07-10T10:00:00"),
  ];
}

function simCategories() {
  return [
    { id: 1001, name: "Content Builder", parentId: 0, categoryType: "asset" },
    { id: 1002, name: "Research Emails", parentId: 1001, categoryType: "asset" },
    { id: 1003, name: "Compliance", parentId: 1001, categoryType: "asset" },
  ];
}

function simAssets() {
  const html = (title: string) =>
    `<html><head><title>${title}</title><script>alert('archived script must never run')</script></head><body><img src="https://image.s10.sfmc-content.com/lib/abc/logo.png" alt="logo"><h1>${title}</h1><p>Dear %%FirstName%%,</p><p>Research is for information only. Investments are subject to market risks.</p><a href="https://www.niveshaay.com/research/q3">Read more</a><img src="https://image.s10.sfmc-content.com/lib/abc/chart.png"></body></html>`;
  const email = (id: number, name: string, subject: string, cat: number, mod: string) => ({
    id,
    customerKey: `asset-${id}`,
    name,
    assetType: { id: 208, name: "htmlemail" },
    category: { id: cat, name: cat === 1002 ? "Research Emails" : "Compliance", parentId: 1001 },
    createdDate: "2025-06-01T10:00:00",
    modifiedDate: mod,
    views: { html: { content: html(name) }, subjectline: { content: subject }, preheader: { content: `${name} preheader` } },
  });
  return [
    email(88231, "Q3 Research Update", "Your Q3 research update is here", 1002, "2025-09-11T17:00:00"),
    email(88190, "Monthly Market Outlook — Aug", "Market outlook for August", 1002, "2025-08-04T17:00:00"),
    email(88102, "Webinar Invitation", "Join our investor webinar", 1002, "2025-07-17T17:00:00"),
    email(88265, "Diwali Portfolio Note", "Portfolio note: festive season", 1002, "2025-10-14T17:00:00"),
    email(79011, "Annual Disclosure 2023", "Annual disclosure document", 1003, "2023-06-19T17:00:00"),
    { id: 5001, customerKey: "asset-5001", name: "Disclaimer block", assetType: { id: 197, name: "htmlblock" }, category: { id: 1003, name: "Compliance", parentId: 1001 }, createdDate: "2024-01-01T10:00:00", modifiedDate: "2025-01-01T10:00:00", content: "<p>Investments in securities market are subject to market risks.</p>" },
    { id: 6001, customerKey: "asset-6001", name: "logo.png", assetType: { id: 28, name: "png" }, category: { id: 1001, name: "Content Builder", parentId: 0 }, createdDate: "2024-01-01T10:00:00", modifiedDate: "2024-01-01T10:00:00", fileProperties: { fileName: "logo.png", publishedURL: "https://image.s10.sfmc-content.com/lib/abc/logo.png" } },
  ];
}
