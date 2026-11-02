// What the SERVER writes to people (push notifications), in each person's own language. Chat notices are different: they are stored as a code and written by each app.
// A language without an entry gets English, never Arabic. Admin-written announcements are the admin's own words (Arabic and English), and other languages get the English one.
import type { AnyLang } from './lang.ts';

interface Words { msg: string; photo: string; video: string; file: string; voice: string; support: string; full: (name: string) => string; near: (name: string, pct: number) => string }
const W: Record<AnyLang, Words> = {
  ar: { msg: 'رسالة جديدة', photo: '📷 صورة', video: '🎥 فيديو', file: '📄 مستند', voice: '🎙 رسالة صوتية', support: 'ردّ فريق ذكرى على رسالتك',
    full: n => `امتلأت مساحة «${n}»: لن تُضاف صور وأصوات جديدة حتى تحصلوا على مساحة أكبر (لا يُحذف شيء).`, near: (n, p) => `مساحة «${n}» وصلت إلى ${p}%. اطلبوا مساحة أكبر قبل أن تمتلئ.` },
  en: { msg: 'New message', photo: '📷 Photo', video: '🎥 Video', file: '📄 Document', voice: '🎙 Voice message', support: 'The Thekra team answered your message',
    full: n => `"${n}" is full: no new photos or voices until you get more space (nothing is deleted).`, near: (n, p) => `"${n}" has used ${p}% of its space. Ask for more before it fills.` },
  ur: { msg: 'نیا پیغام', photo: '📷 تصویر', video: '🎥 ویڈیو', file: '📄 دستاویز', voice: '🎙 صوتی پیغام', support: 'ذکرا ٹیم نے آپ کے پیغام کا جواب دیا ہے',
    full: n => `"${n}" کی جگہ بھر گئی ہے: مزید جگہ ملنے تک نئی تصاویر اور آوازیں شامل نہیں ہوں گی (کچھ بھی حذف نہیں ہوتا)۔`, near: (n, p) => `"${n}" کی ${p}% جگہ استعمال ہو چکی ہے۔ بھرنے سے پہلے مزید جگہ مانگ لیں۔` },
  hi: { msg: 'नया संदेश', photo: '📷 फ़ोटो', video: '🎥 वीडियो', file: '📄 दस्तावेज़', voice: '🎙 वॉइस संदेश', support: 'Thekra टीम ने आपके संदेश का जवाब दिया है',
    full: n => `"${n}" की जगह भर गई है: ज़्यादा जगह मिलने तक नई फ़ोटो और आवाज़ें नहीं जुड़ेंगी (कुछ भी नहीं हटता)।`, near: (n, p) => `"${n}" की ${p}% जगह इस्तेमाल हो चुकी है। भरने से पहले और जगह माँग लें।` },
  tl: { msg: 'Bagong mensahe', photo: '📷 Larawan', video: '🎥 Video', file: '📄 Dokumento', voice: '🎙 Voice message', support: 'Sumagot na ang Thekra team sa mensahe mo',
    full: n => `Puno na ang "${n}": walang madadagdag na larawan o boses hangga't hindi kayo nakakakuha ng mas malaking espasyo (walang binubura).`, near: (n, p) => `${p}% na ng espasyo ng "${n}" ang nagamit. Humingi ng dagdag bago ito mapuno.` },
  fr: { msg: 'Nouveau message', photo: '📷 Photo', video: '🎥 Vidéo', file: '📄 Document', voice: '🎙 Message vocal', support: "L'équipe Thekra a répondu à votre message",
    full: n => `« ${n} » est plein : plus de nouvelles photos ni de voix tant que vous n'avez pas plus d'espace (rien n'est supprimé).`, near: (n, p) => `« ${n} » a utilisé ${p} % de son espace. Demandez-en plus avant qu'il soit plein.` },
  ml: { msg: 'പുതിയ സന്ദേശം', photo: '📷 ഫോട്ടോ', video: '🎥 വീഡിയോ', file: '📄 രേഖ', voice: '🎙 വോയ്സ് സന്ദേശം', support: 'Thekra ടീം നിങ്ങളുടെ സന്ദേശത്തിന് മറുപടി നൽകി',
    full: n => `"${n}" നിറഞ്ഞു: കൂടുതൽ സ്ഥലം ലഭിക്കുന്നതുവരെ പുതിയ ഫോട്ടോകളും ശബ്ദങ്ങളും ചേർക്കാനാവില്ല (ഒന്നും ഇല്ലാതാകില്ല).`, near: (n, p) => `"${n}" ന്റെ ${p}% സ്ഥലം ഉപയോഗിച്ചു. നിറയുന്നതിന് മുമ്പ് കൂടുതൽ ആവശ്യപ്പെടുക.` },
  bn: { msg: 'নতুন বার্তা', photo: '📷 ছবি', video: '🎥 ভিডিও', file: '📄 নথি', voice: '🎙 ভয়েস বার্তা', support: 'Thekra টিম আপনার বার্তার উত্তর দিয়েছে',
    full: n => `"${n}" ভরে গেছে: আরও জায়গা না পাওয়া পর্যন্ত নতুন ছবি বা ভয়েস যোগ হবে না (কিছুই মোছা হয় না)।`, near: (n, p) => `"${n}" এর ${p}% জায়গা ব্যবহৃত হয়েছে। ভরে যাওয়ার আগে আরও জায়গা চেয়ে নিন।` },
  fa: { msg: 'پیام جدید', photo: '📷 عکس', video: '🎥 ویدیو', file: '📄 سند', voice: '🎙 پیام صوتی', support: 'تیم Thekra به پیام شما پاسخ داد',
    full: n => `فضای «${n}» پر شده است: تا زمانی که فضای بیشتری نگیرید، عکس و صدای جدید اضافه نمی‌شود (چیزی حذف نمی‌شود).`, near: (n, p) => `${p}٪ از فضای «${n}» استفاده شده است. پیش از پر شدن، فضای بیشتری بخواهید.` },
  tr: { msg: 'Yeni mesaj', photo: '📷 Fotoğraf', video: '🎥 Video', file: '📄 Belge', voice: '🎙 Sesli mesaj', support: 'Thekra ekibi mesajınızı yanıtladı',
    full: n => `"${n}" doldu: daha fazla alan alana kadar yeni fotoğraf ve ses eklenemez (hiçbir şey silinmez).`, near: (n, p) => `"${n}" alanının %${p}'i kullanıldı. Dolmadan önce daha fazlasını isteyin.` },
  es: { msg: 'Mensaje nuevo', photo: '📷 Foto', video: '🎥 Vídeo', file: '📄 Documento', voice: '🎙 Mensaje de voz', support: 'El equipo de Thekra respondió a tu mensaje',
    full: n => `«${n}» está lleno: no se añadirán fotos ni voces nuevas hasta que tengáis más espacio (no se borra nada).`, near: (n, p) => `«${n}» ha usado el ${p} % de su espacio. Pedid más antes de que se llene.` },
  ru: { msg: 'Новое сообщение', photo: '📷 Фото', video: '🎥 Видео', file: '📄 Документ', voice: '🎙 Голосовое сообщение', support: 'Команда Thekra ответила на ваше сообщение',
    full: n => `Место в «${n}» закончилось: новые фото и голосовые не добавятся, пока вы не получите больше места (ничего не удаляется).`, near: (n, p) => `В «${n}» использовано ${p}% места. Попросите больше, пока оно не заполнилось.` },
  zh: { msg: '新消息', photo: '📷 照片', video: '🎥 视频', file: '📄 文档', voice: '🎙 语音消息', support: 'Thekra 团队已回复你的消息',
    full: n => `“${n}”的空间已满：在获得更多空间之前无法添加新照片和语音（不会删除任何内容）。`, near: (n, p) => `“${n}”已使用 ${p}% 的空间。请在存满之前申请更多空间。` },
  de: { msg: 'Neue Nachricht', photo: '📷 Foto', video: '🎥 Video', file: '📄 Dokument', voice: '🎙 Sprachnachricht', support: 'Das Thekra-Team hat auf deine Nachricht geantwortet',
    full: n => `„${n}“ ist voll: Neue Fotos und Sprachnachrichten können erst wieder hinzugefügt werden, wenn ihr mehr Speicher habt (es wird nichts gelöscht).`, near: (n, p) => `„${n}“ hat ${p} % seines Speichers belegt. Fragt mehr an, bevor er voll ist.` },
  it: { msg: 'Nuovo messaggio', photo: '📷 Foto', video: '🎥 Video', file: '📄 Documento', voice: '🎙 Messaggio vocale', support: 'Il team di Thekra ha risposto al tuo messaggio',
    full: n => `«${n}» è pieno: non si aggiungeranno nuove foto e voci finché non avrete più spazio (non viene cancellato nulla).`, near: (n, p) => `«${n}» ha usato il ${p}% del suo spazio. Chiedetene di più prima che si riempia.` },
  pt: { msg: 'Nova mensagem', photo: '📷 Foto', video: '🎥 Vídeo', file: '📄 Documento', voice: '🎙 Mensagem de voz', support: 'A equipe do Thekra respondeu à sua mensagem',
    full: n => `"${n}" está cheio: não será possível adicionar novas fotos e vozes até que vocês tenham mais espaço (nada é apagado).`, near: (n, p) => `"${n}" usou ${p}% do espaço. Peçam mais antes que encha.` },
  nl: { msg: 'Nieuw bericht', photo: '📷 Foto', video: '🎥 Video', file: '📄 Document', voice: '🎙 Spraakbericht', support: 'Het Thekra-team heeft op je bericht gereageerd',
    full: n => `"${n}" is vol: er kunnen geen nieuwe foto's en stemmen meer bij tot jullie meer ruimte hebben (er wordt niets verwijderd).`, near: (n, p) => `"${n}" heeft ${p}% van de ruimte gebruikt. Vraag meer aan voordat het vol is.` },
  pl: { msg: 'Nowa wiadomość', photo: '📷 Zdjęcie', video: '🎥 Wideo', file: '📄 Dokument', voice: '🎙 Wiadomość głosowa', support: 'Zespół Thekra odpowiedział na Twoją wiadomość',
    full: n => `„${n}” jest pełne: nowe zdjęcia i nagrania nie zostaną dodane, dopóki nie dostaniecie więcej miejsca (nic nie jest usuwane).`, near: (n, p) => `„${n}” wykorzystało ${p}% miejsca. Poproście o więcej, zanim się zapełni.` },
  uk: { msg: 'Нове повідомлення', photo: '📷 Фото', video: '🎥 Відео', file: '📄 Документ', voice: '🎙 Голосове повідомлення', support: 'Команда Thekra відповіла на ваше повідомлення',
    full: n => `Місце в «${n}» закінчилося: нові фото й голосові не додаватимуться, доки ви не отримаєте більше місця (нічого не видаляється).`, near: (n, p) => `У «${n}» використано ${p}% місця. Попросіть більше, доки воно не заповнилося.` },
  el: { msg: 'Νέο μήνυμα', photo: '📷 Φωτογραφία', video: '🎥 Βίντεο', file: '📄 Έγγραφο', voice: '🎙 Φωνητικό μήνυμα', support: 'Η ομάδα του Thekra απάντησε στο μήνυμά σου',
    full: n => `Ο χώρος του «${n}» γέμισε: δεν θα προστεθούν νέες φωτογραφίες και φωνές μέχρι να αποκτήσετε περισσότερο χώρο (δεν διαγράφεται τίποτα).`, near: (n, p) => `Το «${n}» χρησιμοποίησε το ${p}% του χώρου του. Ζητήστε περισσότερο πριν γεμίσει.` },
  sv: { msg: 'Nytt meddelande', photo: '📷 Foto', video: '🎥 Video', file: '📄 Dokument', voice: '🎙 Röstmeddelande', support: 'Thekra-teamet har svarat på ditt meddelande',
    full: n => `"${n}" är fullt: inga nya foton eller röster läggs till förrän ni får mer utrymme (inget raderas).`, near: (n, p) => `"${n}" har använt ${p} % av sitt utrymme. Be om mer innan det blir fullt.` },
};
/** The server's words for one person; an unknown or missing language gets Arabic only when nothing is known at all (as before), otherwise English. */
export const words = (lang: unknown): Words => W[(typeof lang === 'string' && lang in W ? lang : lang === undefined || lang === null ? 'ar' : 'en') as AnyLang];
export const quotaText = (lang: unknown, name: string, level: number) => (level >= 100 ? words(lang).full(name) : words(lang).near(name, level));
