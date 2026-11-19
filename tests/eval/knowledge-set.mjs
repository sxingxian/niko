// The release test set for Knowledge (the plan's "Tests before each release"): a small fictional homeware shop's
// files in every kind Knowledge reads, then questions with known answers. Run with a real AI by
// `npm run eval:knowledge` (see tests/eval/README.md); never part of `npm test`.
// Every fact the questions check is written once, here, so the expected answers can't drift from the files. The XML and
// HTML files are given as the app's reader turns them into text (it reads those in the browser, which Node doesn't have).

export const FILES = [
  { name: 'Team handbook.md', text: `# Returns and exchanges

Customers can return or swap unopened items within 30 days of purchase, with the receipt. The refund goes back to the original payment method.

Without a receipt, Kopi & Co gives store credit only, never cash.

## Faulty items

A faulty item is repaired or replaced while it is within its warranty, even after the 30-day return window. Faulty items are not refunded after 30 days unless the manager agrees.

# Opening hours

The shop opens at 9:00 and closes at 18:00 on weekdays. On Saturdays it opens at 10:00 and closes at 16:00. It is closed on Sundays and public holidays.

# Delivery

Delivery is free for orders over $50. Smaller orders pay $8. Deliveries arrive in 3 to 5 working days.

# Price match

Kopi & Co matches a local competitor's lower price within 7 days of purchase, except during sales.

# Gift cards

Gift cards are valid for 2 years and can't be exchanged for cash.

# Loyalty points

Customers earn 1 point for every dollar spent. 100 points can be used as $5 off.

# Staff

Staff get a 15% discount on everything. Annual leave is 14 days a year; apply at least 2 weeks ahead in the staff app.
` },
  { name: 'Price list 2026.csv', text: `Item,Category,Price,Warranty months,In stock
Blender,Kitchen,129,12,Yes
Kettle,Kitchen,49,12,Yes
Toaster,Kitchen,59,24,Yes
Rice cooker,Kitchen,89,24,Yes
Air fryer,Kitchen,149,12,No
Coffee grinder,Kitchen,79,6,Yes
Desk lamp,Home office,39,12,Yes
Office chair,Home office,249,36,No
Standing desk,Home office,499,60,Yes
Bath towel set,Bathroom,45,0,Yes
` },
  { name: 'Clients.csv', text: `Client,Region,Annual spend,Active,Since,Account manager
Acme Trading,North,12400,Yes,2021-03-04,Dana
Bolt Ltd,South,800,No,2022-07-01,Mei
Cove Pte,North,3000,Yes,2020-01-15,Dana
Dune Co,West,5600,Yes,2023-05-20,Priya
Echo Foods,East,9100,Yes,2019-11-02,Mei
Fern Studio,West,1500,No,2024-02-12,Priya
` },
  { name: 'Contracts.json', text: JSON.stringify([
    { Client: 'Acme Trading', Start: '2025-01-01', Renews: '2026-12-31', 'Notice days': 60, 'Payment terms': '30 days' },
    { Client: 'Cove Pte', Start: '2024-07-01', Renews: '2027-06-30', 'Notice days': 30, 'Payment terms': '14 days' },
    { Client: 'Echo Foods', Start: '2023-03-01', Renews: '2026-02-28', 'Notice days': 90, 'Payment terms': '45 days' },
  ], null, 2) },
  { name: 'Suppliers.xml', text: `## supplier

name: Brightline Appliances
lead-time: 10 working days
minimum-order: $2,000
contact: orders@brightline.example

## supplier

name: Harbour Textiles
lead-time: 21 working days
minimum-order: $500
contact: sales@harbourtextiles.example
` },
  { name: 'IT policy.html', text: `# Passwords

Passwords must be at least 14 characters and are changed once a year. Never share a password, even with IT.

# Laptops

Laptops are replaced every 4 years. Report a lost laptop to IT within 24 hours.

# Suspicious emails

Forward suspicious emails to phishing@kopi.example and then delete them.
` },
];

/** Questions whose answer is in one file: that file must lead, and the answer must hold every `expect` (any one of the
 *  forms in an inner list). */
export const KNOWN = [
  { q: 'How long do customers have to return an unopened item?', file: 'Team handbook.md', expect: [['30 days', 'thirty days']] },
  { q: 'Where does a refund go?', file: 'Team handbook.md', expect: [['original payment']] },
  { q: 'What happens if a customer has no receipt?', file: 'Team handbook.md', expect: [['store credit']] },
  { q: 'Do we fix faulty items after the return window?', file: 'Team handbook.md', expect: [['repair', 'replace']] },
  { q: 'What time does the shop open on Saturdays?', file: 'Team handbook.md', expect: [['10']] },
  { q: 'Are we open on Sundays?', file: 'Team handbook.md', expect: [['closed']] },
  { q: 'When is delivery free?', file: 'Team handbook.md', expect: [['$50', '50 dollars', '50']] },
  { q: 'How much is delivery for a small order?', file: 'Team handbook.md', expect: [['$8', '8 dollars', 'eight']] },
  { q: 'How long does delivery take?', file: 'Team handbook.md', expect: [['3', 'three'], ['5', 'five']] },
  { q: 'Do we match competitors’ prices?', file: 'Team handbook.md', expect: [['7 days', 'seven days', 'within 7', 'a week']] },
  { q: 'How long are gift cards valid?', file: 'Team handbook.md', expect: [['2 years', 'two years']] },
  { q: 'How many loyalty points are worth $5?', file: 'Team handbook.md', expect: [['100']] },
  { q: 'What discount do staff get?', file: 'Team handbook.md', expect: [['15']] },
  { q: 'How many days of annual leave do staff get?', file: 'Team handbook.md', expect: [['14', 'fourteen']] },
  { q: 'How early should I apply for leave?', file: 'Team handbook.md', expect: [['2 weeks', 'two weeks']] },
  { q: 'How much is the blender?', file: 'Price list 2026.csv', expect: [['129']] },
  { q: 'What does the kettle cost?', file: 'Price list 2026.csv', expect: [['49']] },
  { q: 'How long is the toaster’s warranty?', file: 'Price list 2026.csv', expect: [['24', '2 years', 'two years']] },
  { q: 'Is the air fryer in stock?', file: 'Price list 2026.csv', expect: [['no', 'not', 'out of stock']] },
  { q: 'What warranty does the coffee grinder have?', file: 'Price list 2026.csv', expect: [['6', 'six']] },
  { q: 'How much is the standing desk?', file: 'Price list 2026.csv', expect: [['499']] },
  { q: 'How long is the standing desk warranty?', file: 'Price list 2026.csv', expect: [['60', '5 years', 'five years']] },
  { q: 'Is the office chair available?', file: 'Price list 2026.csv', expect: [['no', 'not', 'out of stock']] },
  { q: 'How many kitchen items are in the price list?', file: 'Price list 2026.csv', expect: [['6', 'six']] },
  { q: 'What is the most expensive item in the price list?', file: 'Price list 2026.csv', expect: [['standing desk']] },
  { q: 'Who looks after Acme Trading?', file: 'Clients.csv', expect: [['Dana']] },
  { q: 'How much does Echo Foods spend a year?', file: 'Clients.csv', expect: [['9,100', '9100']] },
  { q: 'Is Bolt Ltd still an active client?', file: 'Clients.csv', expect: [['no', 'not', 'inactive']] },
  { q: 'Which region is Dune Co in?', file: 'Clients.csv', expect: [['West']] },
  { q: 'How many active clients do we have?', file: 'Clients.csv', expect: [['4', 'four']] },
  { q: 'What is the total annual spend of clients in the North region?', file: 'Clients.csv', expect: [['15,400', '15400']] },
  { q: 'Which clients does Priya manage?', file: 'Clients.csv', expect: [['Dune'], ['Fern']] },
  { q: 'When did Cove Pte become a client?', file: 'Clients.csv', expect: [['2020']] },
  { q: 'When does the Acme Trading contract renew?', file: 'Contracts.json', expect: [['31 Dec', 'December 31', '2026-12-31', '31 December']] },
  { q: 'How many days’ notice does the Acme contract need?', file: 'Contracts.json', expect: [['60', 'sixty']] },
  { q: 'What are Cove Pte’s payment terms?', file: 'Contracts.json', expect: [['14']] },
  { q: 'What notice period does Echo Foods have?', file: 'Contracts.json', expect: [['90', 'ninety']] },
  { q: 'When does the Echo Foods contract renew?', file: 'Contracts.json', expect: [['28 Feb', 'February 28', '2026-02-28', '28 February']] },
  { q: 'What is the lead time for Brightline Appliances?', file: 'Suppliers.xml', expect: [['10', 'ten']] },
  { q: 'What is Harbour Textiles’ minimum order?', file: 'Suppliers.xml', expect: [['500']] },
  { q: 'How do I contact Brightline to order?', file: 'Suppliers.xml', expect: [['orders@brightline.example']] },
  { q: 'Which supplier takes longest to deliver?', file: 'Suppliers.xml', expect: [['Harbour']] },
  { q: 'What is the minimum order for Brightline?', file: 'Suppliers.xml', expect: [['2,000', '2000']] },
  { q: 'How long must a password be?', file: 'IT policy.html', expect: [['14', 'fourteen']] },
  { q: 'How often do we change passwords?', file: 'IT policy.html', expect: [['once a year', 'yearly', 'every year', 'annually']] },
  { q: 'How often are laptops replaced?', file: 'IT policy.html', expect: [['4 years', 'four years']] },
  { q: 'What should I do if I lose my laptop?', file: 'IT policy.html', expect: [['24 hours']] },
  { q: 'Where do I send a suspicious email?', file: 'IT policy.html', expect: [['phishing@kopi.example']] },
  { q: 'Can I share my password with IT?', file: 'IT policy.html', expect: [['never', 'no', 'not']] },
  { q: 'From my files, what is our refund policy for faulty items?', file: 'Team handbook.md', expect: [['repair', 'replace']] },
];

/** Questions that have nothing to do with the files: no file may lead them. */
export const UNRELATED = [
  'What is the capital of Japan?',
  'How far is the Moon from the Earth?',
  'Give me a synonym for happy.',
  'What is 17 times 23?',
  'Who wrote Romeo and Juliet?',
  'How many legs does a spider have?',
  'What does photosynthesis do?',
  'Tell me a fun fact about octopuses.',
  'What is the boiling point of water at sea level?',
  'Translate good morning into French.',
];

/**
 * Situations: the rules come from the files and must be applied. `expect` must all be in the answer (any one form per
 * inner list); `not` must not be; `ask: true` means a fact the rules depend on is missing, so Niko should ask (a
 * question or choices) rather than decide.
 */
export const SITUATIONS = [
  { q: 'A customer bought a kettle 40 days ago. It’s faulty. Can I refund it?', expect: [['repair', 'replace']], not: ['yes, refund'] },
  { q: 'A customer bought a blender 3 weeks ago, it’s unopened and they have the receipt. They want their money back. What do I do?', expect: [['refund', 'return']] },
  { q: 'A customer wants to return an unopened toaster from last week but lost the receipt. What can I offer?', expect: [['store credit']] },
  { q: 'A customer’s coffee grinder broke after 8 months. Is it still covered?', expect: [['not', 'no longer', 'expired', 'outside', 'past']] },
  { q: 'A customer’s toaster stopped working after 18 months. What do we do?', expect: [['repair', 'replace']] },
  { q: 'A customer found the blender $20 cheaper at a local shop. They bought ours 5 days ago, not in a sale. What can I do?', expect: [['match', 'refund the difference', '$20']] },
  { q: 'A customer saw the kettle cheaper elsewhere, but they bought ours 10 days ago. Can I match it?', expect: [['no', 'not', "can't", 'cannot', 'past', 'outside']] },
  { q: 'A customer wants to swap a gift card for cash. What do I say?', expect: [['not', "can't", 'cannot', 'no']] },
  { q: 'A customer’s order is $45. How much is delivery?', expect: [['$8', '8 dollars', 'eight']] },
  { q: 'A customer orders the standing desk. Do they pay for delivery?', expect: [['free']] },
  { q: 'A customer has 250 loyalty points. How much off can they get?', expect: [['$10', '10 dollars', 'ten']] },
  { q: 'A staff member wants to buy the office chair. What would they pay?', expect: [['211', '15%', '15 percent']] },
  { q: 'Someone wants to come in on Sunday to pick up an order. Can they?', expect: [['closed', 'not open', 'no']] },
  { q: 'I want to take leave starting next Monday. Is that okay?', expect: [['2 weeks', 'two weeks']] },
  { q: 'I lost my work laptop yesterday afternoon. What now?', expect: [['IT'], ['24 hours', 'right away', 'now', 'as soon']] },
  { q: 'I got an email asking for my password. What should I do?', expect: [['phishing@kopi.example']] },
  { q: 'Acme Trading wants to cancel their contract. What do they need to know?', expect: [['60', 'sixty']] },
  { q: 'A customer wants to return a blender. What should I check?', ask: true },
  { q: 'A customer says their item is faulty. Can I refund it?', ask: true },
  { q: 'A customer wants delivery. How much will it cost?', ask: true },
];

/** The share of each group that must pass for a release. */
export const PASS_AT = { known: 0.9, unrelated: 0.9, situations: 0.8 };
