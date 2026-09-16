import { getSettings } from './settings.js';
import { logEvent, updateSchool, type SchoolRow } from './db.js';

const BASE = 'https://api.hubapi.com';

export async function hubspotEnabled(): Promise<boolean> {
  return Boolean((await getSettings()).hubspotToken);
}

async function hs<T>(token: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HubSpot ${path} ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/**
 * Mirrors a contacted school into HubSpot as Company + Deal + Note.
 * Best effort: a CRM failure must never block or repeat an email send.
 */
export async function logToCrm(school: SchoolRow, email1: { subject: string; body: string }): Promise<void> {
  const settings = await getSettings();
  const token = settings.hubspotToken;
  if (!token) return;
  try {
    let companyId = school.hubspot_company_id;
    if (!companyId) {
      const company = await hs<{ id: string }>(token, '/crm/v3/objects/companies', {
        properties: {
          name: school.name,
          city: school.area ?? 'Lagos',
          country: 'Nigeria',
          industry: 'EDUCATION',
          domain: school.website?.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || undefined,
          description: `Private K-12 school in Lagos. Eduwalls AutoGTM outreach target. Fit score ${school.score ?? 'n/a'}.`,
        },
      });
      companyId = company.id;
      await updateSchool(school.id, { hubspot_company_id: companyId });
    }

    let dealId = school.hubspot_deal_id;
    if (!dealId) {
      const today = new Date().toISOString().slice(0, 10);
      const deal = await hs<{ id: string }>(token, '/crm/v3/objects/deals', {
        properties: {
          dealname: `Eduwalls - ${school.name}`,
          dealstage: 'appointmentscheduled',
          pipeline: 'default',
          description: `Cold outreach initiated ${today}. Email 2 due day ${settings.followUp1Days}. Email 3 due day ${settings.followUp2Days}.`,
        },
        associations: [
          { to: { id: companyId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 5 }] },
        ],
      });
      dealId = deal.id;
      await updateSchool(school.id, { hubspot_deal_id: dealId });
    }

    await hs(token, '/crm/v3/objects/notes', {
      properties: {
        hs_note_body: `Email 1 sent\nSubject: ${email1.subject}\n\n${email1.body}`,
        hs_timestamp: new Date().toISOString(),
      },
      associations: [
        { to: { id: dealId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }] },
      ],
    });

    await logEvent(school.id, 'crm.logged', { companyId, dealId });
  } catch (err) {
    await logEvent(school.id, 'crm.failed', err instanceof Error ? err.message : String(err));
  }
}
