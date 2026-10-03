/**
 * Labels, locales and renaming.
 *
 * Every user-facing string is a key. A tenant — an insurer, or a takaful operator with its own
 * regulated vocabulary — may rename any key in any locale without a code change, and the
 * renaming flows through screens, documents, APIs and statements because everything reads here.
 */
export type Locale = 'en' | 'ar' | 'ms' | 'id' | 'ur' | 'fr' | 'zh';

export interface LabelAudit { readonly at: string; readonly actor: string; readonly tenantId: string; readonly key: string; readonly locale: Locale; readonly from?: string; readonly to: string }

const DEFAULTS: Record<string, Partial<Record<Locale, string>>> = {
  'app.title': { en: 'Central Insurance ERP', ar: 'نظام التأمين المركزي' },
  'nav.policyholder': { en: 'Policyholder', ar: 'حامل الوثيقة' },
  'nav.operator': { en: 'Operations', ar: 'العمليات' },
  'nav.funds': { en: 'Funds & NAV', ar: 'الصناديق وصافي قيمة الأصول' },
  'nav.decisions': { en: 'Decision theatre', ar: 'مسرح القرار' },
  'nav.cover': { en: 'Cover control', ar: 'التحكم بالتغطية' },
  'nav.onboarding': { en: 'Onboarding', ar: 'التسجيل' },
  'nav.ingest': { en: 'Ingestion', ar: 'الاستيراد' },
  'nav.regulatory': { en: 'Regulatory', ar: 'التنظيمي' },
  'nav.ai': { en: 'AI ledger', ar: 'سجل الذكاء الاصطناعي' },
  'policy.premium': { en: 'Premium', ar: 'القسط' },
  'policy.contribution': { en: 'Contribution', ar: 'المساهمة' },
  'policy.sumAssured': { en: 'Sum assured', ar: 'مبلغ التأمين' },
  'policy.holder': { en: 'Policyholder', ar: 'حامل الوثيقة' },
  'policy.certificate': { en: 'Certificate', ar: 'الشهادة' },
  'fund.units': { en: 'Units', ar: 'الوحدات' },
  'fund.nav': { en: 'NAV per unit', ar: 'صافي قيمة الوحدة' },
  'fund.value': { en: 'Fund value', ar: 'قيمة الصندوق' },
  'fund.switch': { en: 'Switch funds', ar: 'تبديل الصناديق' },
  'fund.withdraw': { en: 'Partial withdrawal', ar: 'سحب جزئي' },
  'fund.lookThrough': { en: 'Where your money is invested', ar: 'أين تُستثمر أموالك' },
  'cover.start': { en: 'Start cover', ar: 'بدء التغطية' },
  'cover.stop': { en: 'Stop cover', ar: 'إيقاف التغطية' },
  'cover.schedule': { en: 'Schedule start / stop', ar: 'جدولة البدء والإيقاف' },
  'cover.autoStart': { en: 'Daily renewal at midnight', ar: 'تجديد يومي عند منتصف الليل' },
  'cover.noAutoStartNotice': { en: 'Cover stays stopped until you start it. Nothing restarts by itself.', ar: 'تبقى التغطية متوقفة حتى تبدأها. لا شيء يعود تلقائياً.' },
  'takaful.operator': { en: 'Operator', ar: 'المشغل' },
  'takaful.participant': { en: 'Participant', ar: 'المشارك' },
  'takaful.riskFund': { en: 'Participant risk fund', ar: 'صندوق مخاطر المشاركين' },
  'takaful.tabarru': { en: 'Tabarru (donation)', ar: 'التبّرع' },
  'takaful.qard': { en: 'Qard hasan', ar: 'القرض الحسن' },
  'takaful.surplus': { en: 'Surplus', ar: 'الفائض' },
  'role.surrender': { en: 'Surrender', ar: 'الاستسلام' },
  'disclaimer.illustration': {
    en: 'This is an illustration, not advice or a forecast. Investment values can fall as well as rise and are not guaranteed.',
    ar: 'هذا توضيح وليس نصيحة أو توقعاً. يمكن أن تنخفض قيمة الاستثمار كما يمكن أن ترتفع، وهي غير مضمونة.',
  },
  'disclaimer.lookThrough': { en: 'Market prices are shown for information only and may be delayed.', ar: 'تُعرض أسعار السوق لأغراض المعلومات فقط وقد تكون متأخرة.' },
};

export const DEFAULT_KEYS = Object.keys(DEFAULTS);

export class LabelRegistry {
  private readonly overrides = new Map<string, Partial<Record<Locale, string>>>();  // key|tenantId
  private readonly audit: LabelAudit[] = [];

  t(key: string, locale: Locale = 'en', params?: Record<string, string>, tenantId = 'default'): string {
    const override = this.overrides.get(`${tenantId}|${key}`)?.[locale];
    const base = DEFAULTS[key];
    const text = override ?? base?.[locale] ?? base?.en ?? key;
    if (!params) return text;
    return Object.entries(params).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(v), text);
  }

  rename(input: { tenantId: string; key: string; locale: Locale; text: string; actor: string; at: string }): void {
    const mapKey = `${input.tenantId}|${input.key}`;
    const current = this.overrides.get(mapKey) ?? {};
    this.audit.push({
      actor: input.actor, at: input.at, tenantId: input.tenantId, key: input.key, locale: input.locale,
      to: input.text, from: current[input.locale] ?? DEFAULTS[input.key]?.[input.locale],
    });
    this.overrides.set(mapKey, { ...current, [input.locale]: input.text });
  }

  renameMany(tenantId: string, pairs: Array<{ key: string; locale: Locale; text: string }>, actor: string, at: string): void {
    for (const p of pairs) this.rename({ tenantId, key: p.key, locale: p.locale, text: p.text, actor, at });
  }

  auditTrail(): readonly LabelAudit[] { return this.audit; }

  coverage(locale: Locale, keys: string[] = DEFAULT_KEYS, tenantId = 'default'): { covered: number; total: number; missing: string[] } {
    const missing = keys.filter((k) => !(this.overrides.get(`${tenantId}|${k}`)?.[locale] ?? DEFAULTS[k]?.[locale]));
    return { covered: keys.length - missing.length, total: keys.length, missing };
  }

  /** Export a locale as a flat dictionary — used by documents, statements and API clients. */
  export(locale: Locale, tenantId = 'default'): Record<string, string> {
    return Object.fromEntries(DEFAULT_KEYS.map((k) => [k, this.t(k, locale, undefined, tenantId)]));
  }

  /** The takaful window preset: a conventional vocabulary renamed to regulated takaful terms. */
  static TAKAFUL_REnames(locale: Locale = 'en'): Array<{ key: string; locale: Locale; text: string }> {
    const en: Array<[string, string]> = [
      ['policy.premium', 'Contribution'],
      ['policy.sumAssured', "Tabarru' cover"],
      ['policy.holder', 'Participant'],
      ['policy.certificate', 'Certificate'],
      ['role.surrender', 'Early termination'],
    ];
    const ar: Array<[string, string]> = [
      ['policy.premium', 'المساهمة'],
      ['policy.sumAssured', 'تغطية التبرع'],
      ['policy.holder', 'المشارك'],
      ['policy.certificate', 'الشهادة'],
      ['role.surrender', 'الإنهاء المبكر'],
    ];
    return locale === 'ar'
      ? ar.map(([key, text]) => ({ key, locale, text }))
      : en.map(([key, text]) => ({ key, locale, text }));
  }
}
