/** Ready answers for the questions that come up most. Staff pick one, edit it if they wish, and send. */
export const TEMPLATES = [
  { id: 'number', ar: 'لتغيير رقم هاتفك: افتح «أنت» ثم «الحساب» ثم «تغيير الرقم»، وأدخل الرقم الجديد والرمز الذي يصلك عليه. محادثاتك تبقى كما هي.', en: 'To change your phone number: open "You", then "Account", then "Change number", and enter the new number and the code sent to it. Your chats stay as they are.' },
  { id: 'restore', ar: 'إن حُذفت دائرة بالخطأ فيمكن استرجاعها خلال 90 يوماً من «أنت» ثم «الحساب» ثم «الدوائر المحذوفة».', en: 'A circle deleted by mistake can be restored within 90 days from "You", "Account", "Deleted circles".' },
  { id: 'storage', ar: 'المساحة المجانية لكل عائلة محدودة. يمكن لمدير الدائرة طلب مساحة أكبر من إعدادات الدائرة، تبويب «الوسائط»، زر «احصلوا على مساحة أكبر»، وسنراجع الطلب.', en: 'Each family gets a limited free space. A circle manager can ask for more from the circle settings, "Media" tab, "Get more storage", and we will review the request.' },
  { id: 'code', ar: 'إن لم يصلك رمز التحقق فتأكد من الرقم مع مفتاح الدولة، وانتظر دقيقة ثم أعد الطلب. إن استمر ذلك فأخبرنا باسم شركة الاتصالات التي تستعملها.', en: 'If the verification code does not arrive, check the number with its country code, wait a minute and ask again. If it keeps failing, tell us which mobile operator you use.' },
  { id: 'pin', ar: 'إن نسيت الرمز السري الثنائي فاختر «نسيت الرمز» عند الدخول، وبعد 7 أيام يُزال ويمكنك الدخول بالرمز المرسل فقط. هذه المهلة لحماية حسابك.', en: 'If you forgot your two-step PIN, choose "Forgot PIN" at sign-in; after 7 days it is removed and the SMS code alone signs you in. The wait protects your account.' },
] as const;

