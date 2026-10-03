# 01 — Market landscape and where we win

*Written 2026-10-04. Sources are linked inline; a snapshot of the references is at the bottom. Re-run this review quarterly — the agentic-core race is moving monthly.*

---

## 1. Where the market actually is in 2026

**The core-platform race went agentic this year, and everyone shipped in the same six months.**

| Vendor | Move | Date |
| --- | --- | --- |
| Duck Creek | Insurance-native **Agentic AI Platform** + Agentic Underwriting Workbench + Agentic FNOL; later acquired **Send** for underwriting orchestration | Apr 2026, Jul 2026 |
| Guidewire | **Agentic Framework** in the Qusar release, three pre-built agents (FNOL, claim summarisation, policy change) | Aug 2026 |
| Sapiens | **SapiensAIP** — AI-native autonomous platform across policy, billing, claims, with a Migration Hub | Sep 2026 |
| Earnix | **AIOS** — AI orchestration with governance and human oversight | 2026 |

Concentration is extreme: Guidewire, Duck Creek, Sapiens and Majesco hold **>60% of enterprise SaaS core contracts**; a core replacement runs **$50–300M and 18–36 months**. AI-in-insurance spend is projected to grow from **$8.63B (2025) to $59.5B (2033), ~27% CAGR**. Adoption is real but shallow in production: **90% of carriers are piloting LLMs, 23% run production AI claims adjudication, 14% fully automated commercial underwriting**; **48% of insurers had agentic AI in production by 2026** (up from 8% in 2024).

**Read-through for us:** the incumbents have bolted agents onto twenty-year-old cores, and their own analyst notes admit the deployments are long and heavy. An **AI-native core built agent-first from the first commit** is the opening — not because AI is magic, but because our marginal cost of shipping a module is a fraction of theirs.

## 2. Unit-linked / ILAS: the benchmark you named

**What the market's unit-linked systems do today** (HK ILAS, India ULIP, UK unit-linked, TH bancassurance):

- **Notional units**: premiums buy units after charges; units are a valuation device, not ownership — the insurer owns the underlying assets. ([AIA HK](https://www.aia.com.hk/en/products/invest), [Sun Life HK](https://www.sunlife.com.hk/en/insurance/ilas/), [Aviva](https://static.aviva.io/content/dam/aviva-public/gb/pdfs/personal/retirement/select-investments/shared/xg473.pdf))
- **Charges structured and disclosed**: cost of insurance, premium allocation, policy/admin fee, fund management charge, surrender charge, switching charge, top-up charge. ([AIA HK](https://www.aia.com.hk/en/health-and-wellness/healthy-living-with-aia/healthy-finances/investment-related-life-insurance-plans), [ICICI Pru](https://www.iciciprulife.com/insurance-library/ulips/what-are-ulips.html))
- **NAV and dealing cut-offs**: daily NAV; instructions received before the cut-off (India: 15:00) get that day's closing NAV, otherwise the next business day. ([IRDAI policyholder](https://policyholder.gov.in/unit-linked-insurance-policies), [TaxHeal](https://www.taxheal.com/unit-linked-policy-questions-and-answers.html))
- **Switching and rebalancing**: free switch allowances, automatic switching, periodic rebalancing (e.g. every 3/6/12 months). ([Bangkok Bank/AIA](https://www.bangkokbank.com/en/Personal/My-Family-and-Me/Bancassurance/AIA/BeTogether-Unit-Linked), [Utmost](https://utmostlp.s3.amazonaws.com/documents/UL_guide_-_Utmost_new_funds_-_July_2020.pdf))
- **Partial withdrawal and lock-in**: typically locked for a period (India: 5 years), caps per year (e.g. 20% of fund value), withdrawal by cancellation of units. ([Policybazaar](https://www.policybazaar.com/life-insurance/ulip-plans/), [ICICI Pru](https://www.iciciprulife.com/insurance-library/ulips/what-are-ulips.html))
- **Group unit-linked**: multiple accounts per scheme, per-member fund tracking, unit/zone-wise segregation. ([Aditya Birla Sun Life](https://lifeinsurance.adityabirlacapital.com/uploads/ABSLI_Group_Unit_Linked_Plan_V04_Leaflet_Web_Version_3dc72e6b2a.pdf))
- **Centegy Ascent** (your benchmark) covers general and medical, conventional **and takaful**, with product definition, underwriting, endorsement, claims, reinsurance and finance — 200k policyholders / 1M policies scale. ([Centegy](https://www.centegytechnologies.com/insurance-solutions/))

**Where ILAS-class systems stop:** they report fund values and NAVs. They do **not** let a policyholder interrogate the *decision*. There is no live "if I withdraw 20% today at this NAV, here is the exact unit cancellation, the charge, the remaining cover, and the projected envelope at 3/5/10 years under three scenarios". That is the wedge.

## 3. Takaful: the part western cores handle worst

Takaful is structurally different, and the models are **jurisdiction-specific** — this is why a takaful window cannot be a relabelled conventional product:

- **Fund segregation is central**: participants' risk fund, participants' investment fund, and operator/shareholder fund, with explicit contractual fees. ([NUS SJLS paper](https://law.nus.edu.sg/sjls/wp-content/uploads/sites/14/2024/07/2169-2014-sjls-dec-328.pdf))
- **Models**: wakalah (fee for service), mudarabah (profit share), waqf (endowment), cooperative (KSA only since 2012, policyholders entitled to 10% of net surplus), and hybrids. Surplus sharing is per model and per regulator. ([ISFIN comparison](https://www.isfin.net/sites/isfin.com/files/takaful_business_models._review_and_comparison.pdf))
- **Qard hasan**: the operator must lend interest-free to cover a risk-fund deficit, and the loan is repaid from future surplus. ([Takaful Malaysia](https://www.takaful-malaysia.com.my/wp-content/uploads/2023/08/CorporateProfile_CP2023.pdf))
- **Malaysia/BNM Takaful Operational Framework (2013)**: surplus must be recommended by the **actuary** and endorsed by the **board**, may only be distributed after full valuation and audited results, must respect the surplus management policy approved by the **Shariah Committee**, and can only be paid when there is no deficit. ([BNM TOF](https://penuntutilmu.com/wp-content/uploads/2016/12/2013-06-26-bnm-takaful-operational-framework.pdf))
- **UAE**: Federal Law No. 6 of 2007 governs both conventional and takaful; the UAE takaful law **forbids distributing surplus to savers** in certain structures — a rule a generic engine will get wrong. ([NUS SJLS paper](https://law.nus.edu.sg/sjls/wp-content/uploads/sites/14/2024/07/2169-2014-sjls-dec-328.pdf))

**Read-through:** our Takaful engine is a **model-driven fund and surplus engine** with a Shariah-and-actuary approval workflow, not a flag on a conventional policy. That alone puts us ahead of every western core.

## 4. Pay-as-you-go and start/stop cover

- The market has moved from pilot to mainstream: **278 million active telematics insurance policies projected for 2026**, UBI valued at **$61.8B (2024) → $224B (2035)**; PAYD holds ~60% share, PHYD ~47% of new enrolments. ([FleetRabbit](https://fleetrabbit.com/blogs/post/fleet-insurance-telematics-2026))
- **On-demand (pay-as-you-go) exists but is narrow**: Hugo-style turn-coverage-on-and-off is the exception, typically motor-only, app-bound, and rarely available as a billing primitive inside a core system. ([The Zebra](https://www.thezebra.com/auto-insurance/policies/car-insurance-telematics/))
- Regulators treat UBI as a rating factor with consumer-protection rules (opt-out windows, transparency). ([NAIC](https://content.naic.org/article/consumer-insight-want-your-auto-insurer-track-your-driving-understanding-usage-based-insurance), [Triple-I](https://www.iii.org/article/background-on-pay-as-you-drive-auto-insurance-telematics))

**Read-through:** **daily, pay-as-you-go and start/stop coverage as first-class billing modes across all lines** is genuinely unoccupied territory in core platforms. Your midnight rule (coverage does **not** auto-start unless elected, with scheduled starts/stops) is exactly the consumer-protection-friendly framing regulators like.

## 5. Gap analysis — what nobody ships, and we will

| Capability | Incumbent state | Ours |
| --- | --- | --- |
| Policyholder-level fund transparency to the decision ("what if I withdraw/switch today") | Static statements, illustrations at sale | Live decision engine on real units, real NAV, with charge breakdown and scenario envelopes |
| Takaful models as first-class, multi-jurisdiction | Conventional core + takaful bolt-on | Model-driven participant/operator funds, surplus and qard lifecycle, Shariah + actuary gates |
| Group finance across entities and currencies with inter-company | Separate ERP, nightly interface | One ledger, multi-entity, consolidation and inter-company as native primitives |
| Micro-duration cover (daily / PAYG / start-stop) | Motor-only, bolted-on billing | Billing primitive available to every product line |
| Centralised customer across intermediaries, pushed by API | Each intermediary keeps its own silo | Consent-led "customer already exists" API to any partner system |
| Operator-renamable labels for a takaful entity | Hard-coded terminology, re-implementation per client | Every label/field translatable and renameable per tenant, per language |
| Bulk ingest of any shape, async, AI-supervised | Fixed import templates, batch windows | Any file/text/Excel/API shape, async, idempotent, anomaly agents |
| Agentic AI | Bolted onto legacy cores in 2026 | Agent-first from the first commit, with a governed action ledger |

## 6. Positioning statement

> **The first insurance core built for the agentic era, native to takaful, honest about unit-linked money, and priced by the day.** Incumbents spent 2026 bolting agents onto twentieth-century cores; we start from the sentence "the customer's money is visible, the cover can start and stop, and the Shariah model is a first-class citizen".

## References

- Duck Creek Agentic AI Platform — [PR Newswire](https://www.prnewswire.com/apac/news-releases/duck-creek-launches-insurance-native-agentic-ai-platform-and-unveils-new-applications-to-transform-underwriting-and-claims-302755161.html), [Duck Creek/Send acquisition](https://www.duckcreek.com/resource/press-releases/duck-creek-acquires-send-creating-the-industrys-only-agentic-underwriting-to-core-platform/)
- Guidewire Agentic Framework, Qusar release — [Insurtech Insights](https://www.insurtechinsights.com/news-insights/artificial-intelligence/)
- Sapiens SapiensAIP — [BeInsure](https://beinsure.com/news/sapiens-launches-ai-native-platform/)
- Core platform market concentration, replacement cost, AI adoption rates — [TrendX Insights](https://trendxinsights.com/blogs/p-and-c-core-insurance-market-2026/)
- Agentic adoption statistics and vendor comparison — [FurtherAI](https://www.furtherai.com/blog/top-mobile-insurtech-ai-workspaces-for-agents), [FurtherAI platforms guide](https://www.furtherai.com/blog/ai-platforms-for-insurance-companies)
- Claims agent autonomy ladder (useful for how far to automate claims) — [Hesper AI](https://gethesperai.com/blog/agentic-ai-insurance-claims-beyond-fnol)
- Unit-linked mechanics, charges, NAV cut-offs — [IRDAI policyholder](https://policyholder.gov.in/unit-linked-insurance-policies), [AIA HK](https://www.aia.com.hk/en/health-and-wellness/healthy-living-with-aia/healthy-finances/investment-related-life-insurance-plans), [Sun Life HK](https://www.sunlife.com.hk/en/insurance/ilas/), [Bangkok Bank/AIA](https://www.bangkokbank.com/en/Personal/My-Family-and-Me/Bancassurance/AIA/BeTogether-Unit-Linked), [Utmost](https://utmostlp.s3.amazonaws.com/documents/UL_guide_-_Utmost_new_funds_-_July_2020.pdf)
- Takaful models, surplus, qard, jurisdiction rules — [NUS SJLS](https://law.nus.edu.sg/sjls/wp-content/uploads/sites/14/2024/07/2169-2014-sjls-dec-328.pdf), [BNM Takaful Operational Framework 2013](https://penuntutilmu.com/wp-content/uploads/2016/12/2013-06-26-bnm-takaful-operational-framework.pdf), [Takaful Malaysia](https://www.takaful-malaysia.com.my/wp-content/uploads/2023/08/CorporateProfile_CP2023.pdf), [ISFIN](https://www.isfin.net/sites/isfin.com/files/takaful_business_models._review_and_comparison.pdf)
- UBI / PAYG / on-demand — [FleetRabbit 2026](https://fleetrabbit.com/blogs/post/fleet-insurance-telematics-2026), [The Zebra](https://www.thezebra.com/auto-insurance/policies/car-insurance-telematics/), [NAIC](https://content.naic.org/article/consumer-insight-want-your-auto-insurer-track-your-driving-understanding-usage-based-insurance), [Triple-I](https://www.iii.org/article/background-on-pay-as-you-drive-auto-insurance-telematics)
- Life PAS capability baseline — [Sapiens 2026 guide](https://sapiens.com/resources/blog/life-insurance-policy-administration/)
