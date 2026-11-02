import { I18nManager } from 'react-native';

const ar = {
  appName: 'ذكرى', tagline: 'مراسلة عائلية بذاكرة تدوم', phone: 'رقم الهاتف مع المفتاح (+971...)', name: 'اسمك', code: 'رمز التحقق', next: 'التالي', verify: 'دخول',
  devCode: 'رمز التجربة', chats: 'المحادثات', noChats: 'لا محادثات بعد', write: 'اكتب رسالة', send: 'إرسال', back: 'رجوع', logout: 'خروج', you: 'أنت',
  needPin: 'هذا الحساب محمي برمز سري، وإدخاله غير متاح في هذه النسخة التجريبية من الجوال.', failed: 'تعذّر الإتمام، حاول مرة أخرى', offline: 'لا اتصال بالخادم',
  voice: 'رسالة صوتية', photo: 'صورة', family: 'عائلة', group: 'مجموعة',
  pinPrompt: 'أدخل رمزك السري ذا الستة أرقام', pinWrong: 'الرمز السري غير صحيح', pinLocked: 'محاولات كثيرة. حاول بعد قليل.', pinExpired: 'انتهت مهلة الرمز. ابدأ من جديد.', pinForgot: 'نسيت الرمز السري؟', pinForgotDone: 'يُزال رمزك السري في {d} (بعد 7 أيام حماية لحسابك)، ثم تدخل بالرمز المرسل فقط.',
  supportWrite: 'اكتب لفريق ذكرى', supportSubject: 'الموضوع', supportBody: 'اشرح لنا ما حدث', supportSend: 'إرسال', supportReply: 'اكتب رداً', supportSent: 'وصلت رسالتك، وسنردّ هنا.', supportTeam: 'فريق ذكرى', supportTooMany: 'لديك ثلاثة طلبات مفتوحة، انتظر الرد عليها.', supportStatus: { open: 'مفتوح', answered: 'تم الرد', closed: 'مغلق' } as Record<string, string>,
  account: 'الحساب', cancel: 'إلغاء', deleteTitle: 'حذف حسابي', deleteWarn: 'سيُحذف حسابك نهائياً. ستبقى رسائلك في دوائر العائلة لأهلها دون ربطها بك. لا يمكن التراجع.', deleteConfirm: 'احذف نهائياً', deleteOwns: 'أنت مالك دائرة. انقل ملكيتها أو احذفها من التطبيق على الويب أولاً.', deleteNote: 'حذف الحساب ينهي جلساتك فوراً.',
  inviteTitle: 'دعوة', inviteFromContacts: 'اختر من جهات الاتصال', inviteShare: 'مشاركة رابط الدعوة', noNumber: 'هذه الجهة بلا رقم هاتف', noInviteCode: 'الدعوة مغلقة لهذه الدائرة أو ليست من صلاحيتك',
  inviteText: 'ادعوك للانضمام إلى «{name}» في ذكرى: {link}', invitePrivacy: 'جهات الاتصال تبقى على هاتفك: التطبيق لا يقرأ دفتر العناوين ولا يرفع شيئاً. ما تختاره يفتح رسالة فيها الرابط فقط.', invite: 'دعوة',
};
const en: typeof ar = {
  appName: 'Thekra', tagline: 'Family messaging with a memory that lasts', phone: 'Phone number with country code (+971...)', name: 'Your name', code: 'Verification code', next: 'Next', verify: 'Sign in',
  devCode: 'Test code', chats: 'Chats', noChats: 'No chats yet', write: 'Write a message', send: 'Send', back: 'Back', logout: 'Sign out', you: 'You',
  needPin: 'This account has a PIN; entering it is not available in this early phone build.', failed: 'Could not complete, try again', offline: 'No connection to the server',
  voice: 'Voice message', photo: 'Photo', family: 'Family', group: 'Group',
  pinPrompt: 'Enter your 6-digit PIN', pinWrong: 'The PIN is not right', pinLocked: 'Too many attempts. Try again in a little while.', pinExpired: 'The code expired. Start again.', pinForgot: 'Forgot your PIN?', pinForgotDone: 'Your PIN is removed on {d} (a 7-day wait that protects your account), then the SMS code alone signs you in.',
  supportWrite: 'Write to the Thekra team', supportSubject: 'Subject', supportBody: 'Tell us what happened', supportSend: 'Send', supportReply: 'Write a reply', supportSent: 'Your message arrived, and we will answer here.', supportTeam: 'Thekra team', supportTooMany: 'You have three open cases; wait for an answer.', supportStatus: { open: 'Open', answered: 'Answered', closed: 'Closed' } as Record<string, string>,
  account: 'Account', cancel: 'Cancel', deleteTitle: 'Delete my account', deleteWarn: 'Your account will be deleted for good. Your messages stay in your family circles for the family, no longer tied to you. This cannot be undone.', deleteConfirm: 'Delete for good', deleteOwns: 'You own a circle. Transfer or delete it from the web app first.', deleteNote: 'Deleting your account ends your sessions at once.',
  inviteTitle: 'Invite', inviteFromContacts: 'Pick from contacts', inviteShare: 'Share the invite link', noNumber: 'This contact has no phone number', noInviteCode: 'Invites are off for this circle, or not yours to send',
  inviteText: 'Join "{name}" with me on Thekra: {link}', invitePrivacy: 'Your contacts stay on your phone: the app never reads the address book and uploads nothing. What you pick only opens a message with the link.', invite: 'Invite',
};
export const isArabic = (globalThis as any).Intl?.DateTimeFormat?.().resolvedOptions?.().locale?.startsWith('ar') ?? I18nManager.isRTL;
export const t = isArabic ? ar : en;
