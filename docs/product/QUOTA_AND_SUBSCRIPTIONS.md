# PDF Import Quota & Subscriptions

## Overview

The RAF app now includes a quota system for AI-powered PDF parsing:
- **Free tier**: 3 AI-parsed PDFs per month per household
- **Paid tier**: Unlimited AI-parsed PDFs (requires $2/month subscription)

## How It Works

### Regex Parser (Always Free)
When you upload a bank statement PDF, the regex parser attempts to extract transactions first. This is **always free** and **offline**.

### AI Fallback (Quota Limited)
If the regex parser finds 0 transactions, the AI parser (Claude Sonnet) is triggered **only if**:
1. `ANTHROPIC_API_KEY` is configured in `.env`
2. The household is on the free tier AND has quota remaining, OR on the paid tier

### Quota Tracking
- Free households get **3 AI parses per calendar month** (resets on the 1st of each month)
- Paid households get **unlimited** AI parses
- Usage is tracked in the `pdfImportQuotas` table by `householdId` and `yearMonth`

### Costs
- Regex parsing: **Free** (no API cost)
- AI parsing: ~**$0.01-0.05 per parse** (Claude Sonnet on Anthropic API)
- Expected impact: Only ~2% of imports need AI (99% of common bank formats are handled by regex)

## APIs

### Check Quota Status
```bash
GET /api/v1/household/subscription
```
**Response:**
```json
{
  "tier": "free",
  "remaining": 2,
  "canImport": true,
  "reason": "under_limit"
}
```

### Update Subscription (Manual Admin)
```bash
PATCH /api/v1/household/subscription
Content-Type: application/json

{
  "tier": "paid",
  "expiresAt": "2027-03-01"
}
```
**Response:**
```json
{
  "tier": "paid",
  "expiresAt": "2027-03-01",
  "message": "Subscription updated to paid"
}
```

## Manual Quota Management

### Grant Free User Extra Quota (via DB)
When you manually want to give a free user more quota for a specific month:
1. Add a row to `pdfImportQuotas` or increment the existing `count`:
   ```sql
   UPDATE pdfImportQuotas 
   SET count = count - 1 
   WHERE householdId = 'household_1' AND yearMonth = '2026-03';
   ```

### Upgrade User to Paid
Use the PATCH endpoint:
```bash
curl -X PATCH http://localhost:3000/api/v1/household/subscription \
  -H "Content-Type: application/json" \
  -H "x-household-id: household_1" \
  -d '{"tier":"paid","expiresAt":"2027-03-01"}'
```

### Downgrade User or Set Trial Period
```bash
curl -X PATCH http://localhost:3000/api/v1/household/subscription \
  -H "Content-Type: application/json" \
  -H "x-household-id: household_1" \
  -d '{"tier":"free"}'
```

## Stripe Integration (Future)

When you're ready to charge real money:
1. Create Stripe account and set up a `$2/month` product
2. Update the subscription endpoint to:
   - Call Stripe to create/update a subscription
   - Store `stripeCustomerId` and `stripeSubscriptionId` on the household
   - Use webhooks to update `pdfImportQuotaTier` and `pdfImportQuotaExpiresAt`
3. Add a checkout page in the frontend

For now, you can manually manage subscriptions via the PATCH endpoint or by asking users to send payment screenshots.

## Error Messages

### Quota Exceeded
```
HTTP 429 Too Many Requests

{
  "error": "PDF import quota exceeded. Remaining: 0/3. Upgrade to paid plan for unlimited imports.",
  "errorCode": "BUSINESS_RULE",
  "remaining": 0,
  "tier": "free",
  "reason": "quota_exceeded"
}
```

### Subscription Expired
```
HTTP 429 Too Many Requests

{
  "error": "PDF import quota exceeded. Remaining: 0/3. Upgrade to paid plan for unlimited imports.",
  "remaining": 0,
  "tier": "paid",
  "reason": "subscription_expired"
}
```

## Logs

Watch the server logs for quota activity:
```
[RAF bank import] regex found 0 rows, checking PDF import quota...
[RAF bank import] quota available, attempting AI fallback...
[RAF bank import] AI fallback succeeded, parsed 42 rows
[RAF bank import] failed to record quota usage: ...
```

## Testing

### Test Quota Limit
1. Free household has already used 3 PDFs in current month
2. Upload a PDF with a bank format regex can't parse
3. Expect HTTP 429 with `remaining: 0`

### Test Paid Tier
1. PATCH to `paid` tier: `{"tier":"paid","expiresAt":"2027-01-01"}`
2. Upload many PDFs with unusual formats
3. All should succeed (no 429)

### Test Expiration
1. PATCH to `paid` tier with past date: `{"tier":"paid","expiresAt":"2020-01-01"}`
2. Upload a PDF that needs AI parsing
3. Expect HTTP 429 with `reason: subscription_expired`

## Database Schema

### households (new fields)
- `pdfImportQuotaTier: 'free' | 'paid'` (default: 'free')
- `pdfImportQuotaExpiresAt: string | null` (ISO date, null for free tier)

### pdfImportQuotas (new table)
- `id: string` (UUID)
- `householdId: string` (foreign key to households.id)
- `yearMonth: string` (e.g. '2026-03')
- `count: number` (number of AI parses used this month)
- `createdAt: string` (ISO timestamp)
