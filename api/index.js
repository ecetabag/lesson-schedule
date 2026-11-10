import crypto from 'node:crypto';

const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1ko_r6wSoerKj4XOKOPKHq7f4TFE9xlsqnJ7h00SwTK8';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const APP_TITLE = process.env.APP_TITLE || 'Waterpolo Lesson Schedule';
const TZ = process.env.LESSON_TIMEZONE || 'America/Los_Angeles';
const ORIGIN = process.env.SITE_ORIGIN || 'https://ecetabag.github.io';
const ALLOWED_ORIGINS = new Set([ORIGIN, ...(process.env.ADDITIONAL_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)]);
const DURATIONS = new Set([60, 90]);

const COACH_GUEST_EMAIL = 'albertponfee@gmail.com';
const COACH_PHONE = '5103567916';
const COACH_MAP_LINK = 'https://maps.app.goo.gl/sH9GpLzf94pWavqj9?g_st=ic';
const COACH_LOCATIONS = Object.freeze({
  'tam-high': 'Tamalpais High School, 700 Miller Avenue, Mill Valley, CA 94941',
  'terra-linda-high': 'Terra Linda High School, 320 Nova Albion Way, San Rafael, CA 94903'
});
function directionsFor(location) {
  const address=String(location||'').trim();
  if(!address || address==='Pool')return COACH_MAP_LINK;
  return 'https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(address);
}
function eventDetails(bookingId,notes,location) {
  return 'Booking ID: '+bookingId+
   (notes?'\n\nNotes for coach:\n'+notes:'')+
   '\n\nDirections to the lesson: '+directionsFor(location)+
   '\nAdditional directions provided by coach: '+COACH_MAP_LINK;
}

const BOOKINGS = "'Bookings'!A2:N";
const isSameOrigin = (origin,req) => { try { const u=new URL(origin);return u.protocol==='https:' && u.host===req.headers.host; }catch{return false;} };
const WINDOWS = "'Slots'!A2:G";

const fail = (status, message) => Object.assign(new Error(message), { status });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const id = () => crypto.randomBytes(24).toString('hex');
const clean = value => String(value || '').trim();
const safe = value => /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
const normalizePhone = value => clean(value).replace(/\D/g, '');
const normalizeKid = value => clean(value).replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
const minutes = value => { const [h,m] = String(value).split(':').map(Number); return h*60+m; };
const hhmm = value => [Math.floor(value/60),value%60].map(n => String(n).padStart(2,'0')).join(':');
const validDay = s => /^\d{4}-\d\d-\d\d$/.test(s) && !Number.isNaN(Date.parse(s+'T12:00:00Z'));
const validClock = s => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s);
const durationOf = v => { const d=Number(v); if(!DURATIONS.has(d)) throw fail(400,'Choose a 60- or 90-minute lesson.'); return d; };
const compare = (a,b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
const json = (res, status, value) => { res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value)); };
const envCheck = () => {
 const required=['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN','GOOGLE_CALENDAR_ID','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN'];
 const missing=required.filter(k=>!process.env[k]);
 if(missing.length)throw fail(503,'Booking service is not configured yet.');
};

async function googleToken() {
 const body=new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,refresh_token:process.env.GOOGLE_REFRESH_TOKEN,grant_type:'refresh_token'});
 const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
 const v=await r.json();
 if(!r.ok || !v.access_token)throw fail(503,'Google authorization needs to be refreshed.');
 return v.access_token;
}
async function google(token,method,path,body,params) {
 const url=new URL(path.startsWith('https:')?path:'https://sheets.googleapis.com/v4/'+path);
 for(const [k,v] of Object.entries(params||{}))url.searchParams.set(k,v);
 const r=await fetch(url,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const raw=await r.text();let value;try{value=raw?JSON.parse(raw):{}}catch{value={}};
 if(!r.ok) { console.error('Google API status',r.status,url.host,url.pathname);throw fail(502,'Google Sheets or Calendar could not complete the request.'); }
 return value;
}
const sheets=(token,method,range,body,params) => google(token,method,'spreadsheets/'+encodeURIComponent(SHEET_ID)+'/values/'+encodeURIComponent(range)+(method==='POST'?':append':method==='PUT'?'':'') ,body,params);
async function readRows(token,range){let v=await sheets(token,'GET',range);return v.values||[];}
function bookingRows(data){return data.map((a,i)=>({row:i+2,id:a[0]||'',window:a[2]||'',date:a[3]||'',start:a[4]||'',end:a[5]||'',kid:a[6]||'',email:a[7]||'',phone:a[8]||'',location:a[9]||'',event:a[10]||'',status:a[11]||'',duration:Number(a[13]||30)})).filter(b=>b.id&&b.status==='CONFIRMED');}
function windowsRows(data){return data.map(a=>({id:clean(a[0]),date:clean(a[1]),start:clean(a[2]),end:clean(a[3]),location:clean(a[4])||'Location to be confirmed',status:clean(a[5]).toUpperCase(),legacy:clean(a[6]),coachEmail:clean(a[7]).toLowerCase()})).filter(w=>w.id && w.status==='OPEN' && !w.legacy && validDay(w.date) && validClock(w.start) && validClock(w.end) && minutes(w.end)>minutes(w.start));}
function offsetFor(day) {
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:TZ,timeZoneName:'shortOffset'}).formatToParts(new Date(day+'T12:00:00Z'));
 const part=parts.find(x=>x.type==='timeZoneName')?.value||'GMT';
 const match=part.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
 return match ? (match[1]==='-'?'-':'+')+match[2].padStart(2,'0')+':'+(match[3]||'00') : '+00:00';
}
function instant(day,clock){return new Date(day+'T'+clock+':00'+offsetFor(day));}
const calendarPath=()=> 'https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(CALENDAR_ID)+'/events';
async function calendarEvents(token,day) {
 const start=new Date(day+'T00:00:00'+offsetFor(day));
 const end=new Date(start.getTime()+26*3600000);
 let items=[],page;
 do {
  const out=await google(token,'GET',calendarPath(),undefined,{timeMin:start.toISOString(),timeMax:end.toISOString(),singleEvents:'true',maxResults:'250',...(page?{pageToken:page}:{})});
  items.push(...(out.items||[]));page=out.nextPageToken;
 }while(page);
 return items.filter(e=>e.status!=='cancelled' && e.start?.dateTime && e.end?.dateTime);
}
async function available(token,duration,excludeId) {
 const [bookData,windowData]=await Promise.all([readRows(token,BOOKINGS),readRows(token,WINDOWS)]);
 const bookings=bookingRows(bookData).filter(b=>b.id!==excludeId);
 const windows=windowsRows(windowData);const dates=[...new Set(windows.map(w=>w.date))];
 const cache=new Map();const result=[];
 for(const w of windows) {
  const dayStart=instant(w.date,w.start);
  if(dayStart.getTime()>Date.now()+120*86400000)continue;
  if(!cache.has(w.date))cache.set(w.date,calendarEvents(token,w.date));
  const events=await cache.get(w.date);
  const occupied=bookings.filter(b=>b.window===w.id&&b.date===w.date).map(b=>({a:minutes(b.start),b:minutes(b.end)})).sort((a,b)=>a.a-b.a);
  if(occupied.some((b,i)=>i>0 && b.a!==occupied[i-1].b))continue;
  const low=minutes(w.start),high=minutes(w.end);
  for(let m=low;m+duration<=high;m+=15){
   if(occupied.length && m+duration!==occupied[0].a && m!==occupied[occupied.length-1].b)continue;
   if(occupied.some(b=>m<b.b&&m+duration>b.a))continue;
   const from=instant(w.date,hhmm(m)),to=instant(w.date,hhmm(m+duration));
   if(from.getTime()<Date.now()+3600000||from.getTime()>Date.now()+120*86400000)continue;
   if(events.some(e=>e.id!==excludeId && new Date(e.start.dateTime)<to && new Date(e.end.dateTime)>from))continue;
   result.push({id:w.id+'@'+hhmm(m),windowId:w.id,date:w.date,start:hhmm(m),end:hhmm(m+duration),location:w.location,duration});
  }
 }
 return result.sort((a,b)=>(a.date+a.start).localeCompare(b.date+b.start));
}

/* Coach login: allowlisted email + 6-digit one-time codes. */
const coaches = () => new Set(String(process.env.COACH_EMAILS || '').split(',').map(e=>e.trim().toLowerCase()).filter(Boolean));
const coachCodeKey = email => 'wp:coach:otp:'+sha(email);
async function coachRequestCode(token,data,ip) {
 const email=clean(data.email).toLowerCase();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw fail(400,'Enter a valid coach email.');
 if(!coaches().size)throw fail(503,'Coach login is not configured yet.');
 const message='If this email is an approved coach, a sign-in code has been sent.';
 const rate='wp:coach:rate:'+sha(ip+'|'+email);
 const [count]=await redis([['INCR',rate],['EXPIRE',rate,3600]]);
 if(Number(count)>5||!coaches().has(email))return {message};
 const code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
 await redis([['SET',coachCodeKey(email),sha(email+':'+code),'EX',600],['DEL','wp:coach:attempt:'+sha(email)]]);
 await mail(token,email,APP_TITLE+' provider sign-in code','Your sign-in code is '+code+'. It expires in 10 minutes. If you did not request this, ignore this email.');
 return {message};
}
async function coachVerifyCode(data) {
 const email=clean(data.email).toLowerCase(),code=clean(data.code);
 if(!coaches().has(email)||!/^\d{6}$/.test(code))throw fail(401,'Invalid or expired code.');
 const key='wp:coach:attempt:'+sha(email);
 const [count]=await redis([['INCR',key],['EXPIRE',key,600]]);
 if(Number(count)>5)throw fail(429,'Too many attempts. Request another code.');
 const [expected]=await redis([['GET',coachCodeKey(email)]]);
 if(!expected||!compare(expected,sha(email+':'+code)))throw fail(401,'Invalid or expired code.');
 const session=id();
 await redis([['DEL',coachCodeKey(email)],['SET','wp:coach:session:'+sha(session),email,'EX',28800]]);
 return {token:session,email,expiresIn:28800};
}
async function assertCoach(data) {
 const session=clean(data.token);
 if(session.length!==48)throw fail(401,'Sign in as a coach first.');
 const [email]=await redis([['GET','wp:coach:session:'+sha(session)]]);
 if(!email||!coaches().has(email))throw fail(401,'Your coach session has expired. Sign in again.');
 return email;
}
async function coachAvailability(token,data) {
 const coach=await assertCoach(data);
 const [windows,bookings]=await Promise.all([readRows(token,"'Slots'!A2:H"),readRows(token,BOOKINGS)]);
 return {windows:windowsRows(windows).filter(w=>w.coachEmail===coach).map(w=>({...w,bookingCount:bookingRows(bookings).filter(b=>b.window===w.id).length})).sort((a,b)=>(a.date+a.start).localeCompare(b.date+b.start)),timezone:TZ};
}
async function coachAddWindow(token,data) {
 const coach=await assertCoach(data);
 const day=clean(data.date),start=clean(data.start),end=clean(data.end),location=COACH_LOCATIONS[clean(data.location)];
 if(!validDay(day)||!validClock(start)||!validClock(end))throw fail(400,'Choose a valid date and time.');
 if(minutes(end)<=minutes(start)||minutes(end)-minutes(start)<60||minutes(end)-minutes(start)>720)throw fail(400,'Teaching windows must be between 1 and 12 hours.');
 if(!location)throw fail(400,'Choose Tam High or Terra Linda High School.');
 if(instant(day,start).getTime()<=Date.now())throw fail(400,'Choose a future availability window.');
 if(instant(day,start).getTime()>Date.now()+120*86400000)throw fail(400,'Availability may be added up to 120 days ahead.');
 return lockDay(day,async()=>{
  const rows=windowsRows(await readRows(token,WINDOWS));
  if(rows.some(w=>w.date===day&&minutes(start)<minutes(w.end)&&minutes(end)>minutes(w.start)))throw fail(409,'This teaching window overlaps another open window.');
  const windowId='WP-'+crypto.randomUUID().slice(0,12).toUpperCase();
  await sheets(token,'PUT',"'Slots'!H1",{values:[['Coach Email']]},{valueInputOption:'RAW'});
  await sheets(token,'POST',"'Slots'!A:H",{values:[[windowId,day,start,end,safe(location),'OPEN','',coach]]},{valueInputOption:'RAW',insertDataOption:'INSERT_ROWS'});
  try{await notifyWaitlist(token,day)}catch(e){console.error('Waitlist notification deferred',e.message)}
  return {window:{id:windowId,date:day,start,end,location,status:'OPEN',bookingCount:0}};
 });
}
async function coachRemoveWindow(token,data) {
 const coach=await assertCoach(data);
 const windowId=clean(data.windowId);
 const all=await readRows(token,"'Slots'!A2:H");
 const matched=all.find(row=>clean(row[0])===windowId && clean(row[7]).toLowerCase()===coach);
 if(!matched)throw fail(404,'Teaching window not found.');
 const day=clean(matched[1]);
 return lockDay(day,async()=>{
  const updated=await readRows(token,"'Slots'!A2:H");
  const index=updated.findIndex(row=>clean(row[0])===windowId && clean(row[7]).toLowerCase()===coach && clean(row[5]).toUpperCase()==='OPEN');
  if(index<0)throw fail(409,'Teaching window is no longer open.');
  if(bookingRows(await readRows(token,BOOKINGS)).some(b=>b.window===windowId))throw fail(409,'This window has bookings. Keep it open or move the lessons first.');
  await sheets(token,'PUT',"'Slots'!F"+(index+2),{values:[['CLOSED']]},{valueInputOption:'RAW'});
  return {success:true};
 });
}
async function coachSignOut(data){
 const session=clean(data.token);
 if(session.length===48)await redis([['DEL','wp:coach:session:'+sha(session)]]);
 return {success:true};
}

async function redis(commands) {
 const url=process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/,'')+'/pipeline';
 const r=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+process.env.UPSTASH_REDIS_REST_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(commands)});
 if(!r.ok)throw fail(503,'Scheduling security service unavailable.');
 const v=await r.json();if(!Array.isArray(v)||v.some(x=>x.error))throw fail(503,'Scheduling security service unavailable.');
 return v.map(x=>x.result);
}
async function lockDay(day,work) {
 const key='wp:lock:'+day, token=id();
 const [ok]=await redis([['SET',key,token,'NX','PX',60000]]);
 if(ok!=='OK')throw fail(409,'A booking is being processed. Please try again.');
 try{return await work();}finally{await redis([['EVAL',"if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",1,key,token]]).catch(()=>{});}
}
async function mail(token,to,subject,body,html=null) {
 // Encode the subject and MIME bodies so names, punctuation and links render consistently.
 const subjectHeader='=?UTF-8?B?'+Buffer.from(String(subject).replace(/[\r\n]/g,' '),'utf8').toString('base64')+'?=';
 const headers=['To: '+String(to).replace(/[\r\n]/g,''),'Subject: '+subjectHeader,'MIME-Version: 1.0'];
 let message;
 if(html){
  const boundary='ondeck_'+crypto.randomBytes(12).toString('hex');
  message=[...headers,'Content-Type: multipart/alternative; boundary="'+boundary+'"','',
   '--'+boundary,'Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',
   Buffer.from(body,'utf8').toString('base64'),
   '--'+boundary,'Content-Type: text/html; charset=UTF-8','Content-Transfer-Encoding: base64','',
   Buffer.from(html,'utf8').toString('base64'),
   '--'+boundary+'--',''].join('\r\n');
 }else{
  message=[...headers,'Content-Type: text/plain; charset=UTF-8','',''+body].join('\r\n');
 }
 const raw=Buffer.from(message,'utf8').toString('base64url');
 await google(token,'POST','https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{raw});
}

/* OnDeck transactional emails. Use conservative table markup + inline CSS for email clients. */
const escapeEmailHtml = value => String(value??'').replace(/[&<>"']/g,ch=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
})[ch]);
const bookingFriendlyDate = date => new Date(date+'T12:00:00Z').toLocaleDateString('en-US',{
 weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'UTC'
});
const bookingFriendlyTime = value => {
 const [h,m]=String(value).split(':').map(Number);
 return (h%12||12)+':'+String(m).padStart(2,'0')+' '+(h<12?'AM':'PM');
};
const durationLabel = n => Number(n)===90?'1 hour 30 minutes':'1 hour';
const BOOKING_MANAGE_LINK='https://lesson-schedule-lake.vercel.app/?view=manage';
const BOOKING_HOME_LINK='https://lesson-schedule-lake.vercel.app/';
function emailDetailRow(label,value){
 return '<tr><td style="padding:9px 0;color:#798a80;font-size:13px;vertical-align:top;width:38%;">'+escapeEmailHtml(label)+
 '</td><td style="padding:9px 0;color:#263b34;font-size:13px;line-height:1.5;font-weight:600;text-align:right;vertical-align:top;word-break:break-word;">'+escapeEmailHtml(value)+'</td></tr>';
}
function designedEmail(title,lead,details,links,closing,badge){
 const button=links.map(link=>'<a href="'+escapeEmailHtml(link.url)+'" style="display:inline-block;box-sizing:border-box;padding:14px 22px;margin:0 8px 10px 0;background:'+
 (link.secondary?'#f6f9f5':'#9EF5C3')+';color:#171b2a;border:1px solid '+(link.secondary?'#dce6df':'#88ddaE')+
 ';border-radius:8px;font-weight:700;text-decoration:none;font-size:13px;">'+escapeEmailHtml(link.text)+'</a>').join('');
 return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'+
 '<body style="margin:0;padding:30px 12px;background:#f6f8f5;color:#243a35;font-family:Arial,Helvetica,sans-serif;">'+
 '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;width:100%;margin:0 auto;background:#ffffff;border:1px solid #e1eae3;border-radius:16px;overflow:hidden;">'+
 '<tr><td style="padding:22px 28px;background:#171b2a;color:#ffffff;font-size:23px;font-weight:750;letter-spacing:-.8px;">'+
 '<span style="color:#9EF5C3;">◆</span> OnDeck</td></tr>'+
 '<tr><td style="padding:30px 28px 31px;">'+
 '<div style="display:inline-block;background:#e8fbed;border:1px solid #b9e9c8;border-radius:20px;padding:7px 11px;color:#256a45;font-size:11px;font-weight:700;letter-spacing:.5px;">'+escapeEmailHtml(badge)+'</div>'+
 '<h1 style="font-size:24px;line-height:1.28;letter-spacing:-.55px;margin:16px 0 10px;color:#192f29;font-weight:700;">'+escapeEmailHtml(title)+'</h1>'+
 '<p style="font-size:14px;line-height:1.75;color:#67796d;margin:0 0 22px;">'+escapeEmailHtml(lead)+'</p>'+
 '<div style="background:#fafbf9;border:1px solid #e1e9e2;border-radius:10px;padding:14px 18px;margin:0 0 23px;">'+
 '<p style="font-size:10px;letter-spacing:1.6px;color:#839489;font-weight:700;margin:0 0 9px;">LESSON DETAILS</p>'+
 '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">'+details+'</table></div>'+
 '<div style="margin:0 0 14px;">'+button+'</div>'+
 '<p style="font-size:13px;color:#657a6b;line-height:1.75;margin:8px 0 0;">'+closing+'</p>'+
 '</td></tr>'+
 '<tr><td style="padding:17px 28px;background:#f5f8f5;color:#87968c;font-size:11px;">OnDeck · Scheduling pages, made for you.</td></tr>'+
 '</table></body></html>';
}
function bookingEmailTemplates(b){
 const date=bookingFriendlyDate(b.date),time=bookingFriendlyTime(b.start)+' – '+bookingFriendlyTime(b.end);
 const directions=directionsFor(b.location),notes=b.notes||'';
 const baseRows=emailDetailRow('Date',date)+emailDetailRow('Time',time)+
  emailDetailRow('Duration',durationLabel(b.duration))+emailDetailRow('Location',b.location)+
  emailDetailRow('Participant',b.kid);
 const clientRows=baseRows+(notes?emailDetailRow('Notes',notes):'');
 const coachRows=baseRows+emailDetailRow('Parent email',b.email)+emailDetailRow('Parent phone',b.phone)+
  (notes?emailDetailRow('Notes',notes):'');
 const clientPlain='Thank you for booking a private water polo lesson!\n\nYour lesson is confirmed.\n\n'+
  'Participant: '+b.kid+'\nDate: '+date+'\nTime: '+time+'\nDuration: '+durationLabel(b.duration)+
  '\nLocation: '+b.location+(notes?'\nNotes: '+notes:'')+
  '\n\nDirections: '+directions+
  '\nAdditional pool directions: '+COACH_MAP_LINK+
  '\n\nIf you need to change or modify your lesson, manage your booking here: '+BOOKING_MANAGE_LINK+
  '\nYou can reach me at (510) 356-7916.\n\nSee you at the pool!\nAlbert';
 const coachPlain='New private lesson booked: '+date+'\n\n'+
  'Time: '+time+'\nDuration: '+durationLabel(b.duration)+'\nLocation: '+b.location+
  '\nParticipant: '+b.kid+'\nParent email: '+b.email+'\nParent phone: '+b.phone+
  (notes?'\nNotes: '+notes:'')+
  '\n\nDirections: '+directions+'\nAdditional pool directions: '+COACH_MAP_LINK+
  '\n\nBooking ID: '+b.bookingId+'\nOpen bookings: '+BOOKING_HOME_LINK;
 const clientHtml=designedEmail('Your private lesson is booked!',
  'Thank you for booking a private water polo lesson. Here are your details:',
  clientRows,[{text:'Manage your lesson',url:BOOKING_MANAGE_LINK},{text:'Get directions',url:directions,secondary:true}],
  'Need to change anything? Use the Manage lesson button above, or call or text Albert at <a href="tel:+15103567916" style="color:#24543d;font-weight:700;">(510) 356-7916</a>.<br>See you at the pool!', '✓ CONFIRMED');
 const coachHtml=designedEmail('New private lesson booked',
  'A new water polo lesson has been confirmed for '+date+'.',
  coachRows,[{text:'View booking page',url:BOOKING_HOME_LINK},{text:'Directions',url:directions,secondary:true}],
  'Booking ID: '+escapeEmailHtml(b.bookingId)+'<br>Coach phone: (510) 356-7916.', 'NEW BOOKING');
 return {client:{subject:'Your private water polo lesson is confirmed',plain:clientPlain,html:clientHtml},
 coach:{subject:'New private lesson booked: '+date,plain:coachPlain,html:coachHtml}};
}

async function booking(token,data) {
 const duration=durationOf(data.duration),slotId=clean(data.slotId),kid=clean(data.kidName),email=clean(data.email).toLowerCase(),phone=clean(data.phone),notes=clean(data.notes);
 if(kid.length<2||kid.length>100||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!/^[+\d\s().-]{7,24}$/.test(phone))throw fail(400,'Enter the participant name, a valid email, and phone number.');
 if(notes.length>500)throw fail(400,'Notes must be 500 characters or fewer.');
 const requestedDay=slotId.split('@')[0]; // Lookup actual window ID below; IDs need not be dates.
 const windows=windowsRows(await readRows(token,WINDOWS));const window=windows.find(w=>w.id===requestedDay);
 if(!window)throw fail(409,'That lesson time is no longer available.');
 return lockDay(window.date,async()=>{
  const slot=(await available(token,duration,null)).find(s=>s.id===slotId);
  if(!slot)throw fail(409,'That lesson time is no longer available.');
  const bookingId=crypto.randomUUID().replaceAll('-',''),eventId=bookingId;
  const start=instant(slot.date,slot.start),end=instant(slot.date,slot.end);
  const event={id:eventId,summary:'Waterpolo Lesson',location:slot.location,description:eventDetails(bookingId,notes,slot.location),start:{dateTime:start.toISOString(),timeZone:TZ},end:{dateTime:end.toISOString(),timeZone:TZ},attendees:[...new Set([email,COACH_GUEST_EMAIL])].map(address=>({email:address}))};
  await google(token,'POST',calendarPath(),event,{sendUpdates:'all'});
  try{
   const values=[[bookingId,new Date().toISOString(),slot.windowId,slot.date,slot.start,slot.end,safe(kid),email,safe(phone),safe(slot.location),eventId,'CONFIRMED',new Date().toISOString(),duration,safe(notes)]];
   await sheets(token,'POST',"'Bookings'!A:O",{values},{valueInputOption:'RAW',insertDataOption:'INSERT_ROWS'});
  }catch(e){await google(token,'DELETE',calendarPath()+'/'+eventId).catch(()=>{});throw e;}
  // Notifications are sent only after the calendar event and Sheet record both exist.
  // A mail problem must not make a successful booking appear to have failed.
  const templates=bookingEmailTemplates({bookingId,kid,email,phone,notes,date:slot.date,start:slot.start,end:slot.end,duration,location:slot.location});
  const results=await Promise.allSettled([
    mail(token,email,templates.client.subject,templates.client.plain,templates.client.html),
    mail(token,COACH_GUEST_EMAIL,templates.coach.subject,templates.coach.plain,templates.coach.html)
  ]);
  if(results[0].status==='rejected')console.error('Client booking email failed for',bookingId,results[0].reason?.message);
  if(results[1].status==='rejected')console.error('Coach booking email failed for',bookingId,results[1].reason?.message);
  return {bookingId,date:slot.date,start:slot.start,end:slot.end,duration,location:slot.location,directionsUrl:directionsFor(slot.location),timezone:TZ,confirmationEmailSent:results[0].status==='fulfilled',coachEmailSent:results[1].status==='fulfilled'};
 });
}
async function findBookings(token,phone,kid) {
 const rows=bookingRows(await readRows(token,BOOKINGS));
 return rows.filter(b=>normalizePhone(b.phone)===normalizePhone(phone)&&normalizeKid(b.kid)===normalizeKid(kid)&&instant(b.date,b.start).getTime()>Date.now());
}
const identity = data => {
 const phone=normalizePhone(data.phone),kid=normalizeKid(data.kidName);
 if(phone.length<7||phone.length>15||kid.length<2||kid.length>100)throw fail(400,'Enter a valid phone number and participant name.');
 return {phone,kid,key:sha(phone+'|'+kid)};
};
async function requestCode(token,data,ip) {
 const who=identity(data);const rateKey='wp:rate:'+sha(ip+'|'+who.key).slice(0,40);
 const [count]=await redis([['INCR',rateKey],['EXPIRE',rateKey,3600]]);
 if(Number(count)>5)return {message:'If a booking exists, a code was sent to its email.'};
 const matches=await findBookings(token,who.phone,who.kid);
 if(matches.length){
  const code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
  const key='wp:otp:'+who.key;
  await redis([['SET',key,sha(who.key+':'+code),'EX',600],['DEL','wp:attempts:'+who.key]]);
  await mail(token,matches[0].email,'Your booking verification code','Your code is '+code+'. It expires in 10 minutes. If you did not request this, ignore this message.');
 }
 return {message:'If a booking exists, a code was sent to its email.'};
}
async function verifyCode(token,data) {
 const who=identity(data);const code=clean(data.code);
 if(!/^\d{6}$/.test(code))throw fail(400,'Enter the six-digit code.');
 const [tries]=await redis([['INCR','wp:attempts:'+who.key],['EXPIRE','wp:attempts:'+who.key,600]]);
 if(Number(tries)>5)throw fail(429,'Too many attempts. Request a new code.');
 const [expected]=await redis([['GET','wp:otp:'+who.key]]);
 if(!expected||!compare(expected,sha(who.key+':'+code)))throw fail(401,'Invalid or expired verification code.');
 const session=id();
 await redis([['SET','wp:session:'+sha(session),who.key,'EX',1800],['DEL','wp:otp:'+who.key]]);
 const matches=await findBookings(token,who.phone,who.kid);
 return {token:session,bookings:matches.map(b=>({bookingId:b.id,date:b.date,start:b.start,end:b.end,duration:b.duration}))};
}
async function authorized(token,data){
 const who=identity(data),session=clean(data.token);
 if(session.length!==48)throw fail(401,'Please verify your booking first.');
 const [key]=await redis([['GET','wp:session:'+sha(session)]]);
 if(!key||!compare(key,who.key))throw fail(401,'Session expired. Please verify again.');
 const matches=await findBookings(token,who.phone,who.kid);
 const booking=matches.find(b=>b.id===clean(data.bookingId));
 if(!booking)throw fail(404,'Booking not found.');
 return booking;
}
async function rescheduleOptions(token,data){
 const booking=await authorized(token,data);
 return {slots:await available(token,booking.duration,booking.id),duration:booking.duration};
}
async function reschedule(token,data){
 const booking=await authorized(token,data),requested=clean(data.slotId);
 const windows=windowsRows(await readRows(token,WINDOWS));
 const destination=windows.find(w=>requested.startsWith(w.id+'@'));
 if(!destination)throw fail(409,'That lesson time is no longer available.');
 // Lock both dates in deterministic order to prevent races and preserve the adjacency rule.
 const keys=[...new Set([booking.date,destination.date])].sort();
 const run=async i=>i===keys.length?await move():lockDay(keys[i],()=>run(i+1));
 const move=async()=>{
  const current=await authorized(token,data);
  const options=await available(token,current.duration,current.id),slot=options.find(s=>s.id===requested);
  if(!slot)throw fail(409,'That time is no longer available.');
  const before=await google(token,'GET',calendarPath()+'/'+encodeURIComponent(current.event));
  const start=instant(slot.date,slot.start),end=instant(slot.date,slot.end);
  await google(token,'PATCH',calendarPath()+'/'+encodeURIComponent(current.event),{start:{dateTime:start.toISOString(),timeZone:TZ},end:{dateTime:end.toISOString(),timeZone:TZ},location:slot.location,summary:'Waterpolo Lesson',description:eventDetails(current.id,(before.description||'').split('Notes for coach:\n')[1]?.split('\n\nDirections to the lesson:')[0]||'',slot.location),attendees:[...new Set([...(before.attendees||[]).map(a=>a.email).filter(Boolean),COACH_GUEST_EMAIL])].map(address=>({email:address}))},{sendUpdates:'all'});
  try{
   await google(token,'POST','spreadsheets/'+encodeURIComponent(SHEET_ID)+'/values:batchUpdate',{
    valueInputOption:'RAW',
    data:[
      {range:"'Bookings'!C"+current.row+':F'+current.row,values:[[slot.windowId,slot.date,slot.start,slot.end]]},
      {range:"'Bookings'!J"+current.row,values:[[safe(slot.location)]]},
      {range:"'Bookings'!M"+current.row,values:[[new Date().toISOString()]]}
    ]
   });
  }catch(e){
   await google(token,'PATCH',calendarPath()+'/'+encodeURIComponent(current.event),{start:before.start,end:before.end,location:before.location,summary:before.summary,description:before.description,attendees:before.attendees},{sendUpdates:'all'}).catch(()=>{});
   throw e;
  }
  return {booking:{bookingId:current.id,date:slot.date,start:slot.start,end:slot.end,duration:current.duration}};
 };
 return run(0);
}


/* Opt-in waitlist, next-day reminders and weekly coach publishing nudges. */
const WAITLIST_RANGE = "'Waitlist'!A2:I";
const SITE_URL = process.env.PUBLIC_SITE_URL || 'https://lesson-schedule-lake.vercel.app/';
const todayInZone = () => new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function localDayPlus(days){
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
 const obj=Object.fromEntries(parts.map(p=>[p.type,p.value]));
 const base=new Date(Date.UTC(Number(obj.year),Number(obj.month)-1,Number(obj.day)+days,12));
 return base.toISOString().slice(0,10);
}
async function ensureWaitlist(token) {
 const metadata=await google(token,'GET','spreadsheets/'+encodeURIComponent(SHEET_ID),undefined,{fields:'sheets.properties.title'});
 if(!(metadata.sheets||[]).some(s=>s.properties.title==='Waitlist')){
  try{
   await google(token,'POST','spreadsheets/'+encodeURIComponent(SHEET_ID)+':batchUpdate',{requests:[{addSheet:{properties:{title:'Waitlist',gridProperties:{frozenRowCount:1}}}}]});
  }catch(e){
   const second=await google(token,'GET','spreadsheets/'+encodeURIComponent(SHEET_ID),undefined,{fields:'sheets.properties.title'});
   if(!(second.sheets||[]).some(s=>s.properties.title==='Waitlist'))throw e;
  }
 }
 await sheets(token,'PUT',"'Waitlist'!A1:I1",{values:[['Waitlist ID','Created At','Requested Date','Duration (minutes)','Participant','Email','Status','Notified At','Unsubscribe Token']]},{valueInputOption:'RAW'});
}
function waitRows(rows){
 return rows.map((a,i)=>({row:i+2,id:clean(a[0]),date:clean(a[2]),duration:Number(a[3]),participant:clean(a[4]),email:clean(a[5]).toLowerCase(),status:clean(a[6]),notifiedAt:clean(a[7]),unsubscribe:clean(a[8])})).filter(w=>w.id);
}
async function joinWaitlist(token,data,ip){
 const date=clean(data.date),duration=durationOf(data.duration),email=clean(data.email).toLowerCase(),participant=clean(data.participant);
 if(!validDay(date)||instant(date,'23:59').getTime()<Date.now()||instant(date,'00:00').getTime()>Date.now()+120*86400000)throw fail(400,'Choose a date within the next 120 days.');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||participant.length<2||participant.length>100)throw fail(400,'Enter a valid participant name and email.');
 if(data.consent!==true)throw fail(400,'Please agree to receive an availability email.');
 const rate='wp:wait:rate:'+sha(ip).slice(0,40);
 const [count]=await redis([['INCR',rate],['EXPIRE',rate,3600]]);
 if(Number(count)>5)throw fail(429,'Too many waitlist requests. Try again later.');
 await ensureWaitlist(token);
 const existing=waitRows(await readRows(token,WAITLIST_RANGE));
 if(existing.some(w=>w.date===date&&w.duration===duration&&w.email===email&&w.status==='WAITING'))return {message:'You are already on the waitlist for that day.'};
 const tokenValue=id();
 const entry=['WL-'+crypto.randomUUID(),new Date().toISOString(),date,duration,safe(participant),email,'WAITING','',tokenValue];
 await sheets(token,'POST',"'Waitlist'!A:I",{values:[entry]},{valueInputOption:'RAW',insertDataOption:'INSERT_ROWS'});
 return {message:'You are on the waitlist. We will email you if a lesson time becomes available. A time is not reserved.'};
}
async function unsubscribeWaitlist(token,data){
 const unsubscribe=clean(data.token);
 if(!/^[a-f0-9]{48}$/.test(unsubscribe))throw fail(400,'Invalid unsubscribe link.');
 await ensureWaitlist(token);
 const match=waitRows(await readRows(token,WAITLIST_RANGE)).find(w=>w.unsubscribe===unsubscribe);
 if(match&&match.status==='WAITING')await sheets(token,'PUT',"'Waitlist'!G"+match.row,{values:[['UNSUBSCRIBED']]},{valueInputOption:'RAW'});
 return {message:'You have been removed from the waitlist.'};
}
async function mailOnce(token,redisKey,to,subject,body,seconds=86400*7){
 const [added]=await redis([['SET',redisKey,'1','NX','EX',seconds]]);
 if(added!=='OK')return false;
 try{await mail(token,to,subject,body);return true}
 catch(e){await redis([['DEL',redisKey]]).catch(()=>{});throw e}
}
async function notifyWaitlist(token,onlyDate=null){
 await ensureWaitlist(token);
 const rows=waitRows(await readRows(token,WAITLIST_RANGE)).filter(w=>w.status==='WAITING'&&(!onlyDate||w.date===onlyDate)&&instant(w.date,'23:59').getTime()>Date.now());
 if(!rows.length)return {sent:0,checked:0};
 const byDuration=new Map(),cache=new Map();
 let sent=0,checked=0;
 for(const entry of rows.slice(0,40)){
  checked++;
  if(!byDuration.has(entry.duration))byDuration.set(entry.duration,available(token,entry.duration,null));
  const all=await byDuration.get(entry.duration);
  if(!all.some(slot=>slot.date===entry.date))continue;
  const key='wp:wait:sent:'+sha(entry.id);
  const link=SITE_URL+'#booking';
  const optout=SITE_URL+'?unsubscribe='+encodeURIComponent(entry.unsubscribe);
  try{
   if(await mailOnce(token,key,entry.email,APP_TITLE+' — lesson time available',
    'Hi '+entry.participant+',\n\nA lesson time has opened up for '+entry.date+' ('+entry.duration+' minutes).\nBook here: '+link+
    '\n\nThis is a notification, not a reservation. Times are first come, first served.\n\nStop these alerts: '+optout,86400*14)){
    await sheets(token,'PUT',"'Waitlist'!G"+entry.row+':H'+entry.row,{values:[['NOTIFIED',new Date().toISOString()]]},{valueInputOption:'RAW'});
    sent++;
   }
  }catch(e){console.error('Waitlist email failed',entry.id,e.message)}
 }
 return {sent,checked};
}
async function sendDailyReminders(token){
 const tomorrow=localDayPlus(1);
 const rows=bookingRows(await readRows(token,BOOKINGS)).filter(b=>b.date===tomorrow&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email));
 let sent=0;
 for(const b of rows.slice(0,50)){
  const key='wp:reminder:'+sha(b.id+'|'+b.date);
  try{
   if(await mailOnce(token,key,b.email,APP_TITLE+' — lesson reminder',
    'Reminder: '+b.kid+' has a lesson tomorrow ('+b.date+') at '+b.start+' ('+b.duration+' minutes).\nLocation: '+b.location+
    '\n\nTo manage your booking, visit '+SITE_URL+'\n\nTimes are in '+TZ+'.',86400*5))sent++;
  }catch(e){console.error('Reminder failed',b.id,e.message)}
 }
 return {sent,candidates:rows.length,date:tomorrow};
}
async function promptCoaches(token){
 const localDate=localDayPlus(0);
 const weekday=new Date(localDate+'T12:00:00Z').getUTCDay();
 if(weekday!==1)return {sent:0,reason:'not Monday'};
 const coachesList=[...coaches()];
 const windows=windowsRows(await readRows(token,"'Slots'!A2:H"));
 const horizon=localDayPlus(14);
 let sent=0;
 for(const email of coachesList){
  if(windows.some(w=>w.coachEmail===email&&w.date>=localDate&&w.date<=horizon))continue;
  const key='wp:coach:nudge:'+sha(email);
  try{
   if(await mailOnce(token,key,email,APP_TITLE+' — please add your available hours',
    'Hi,\n\nYou do not have any open teaching windows published for the next two weeks.\n\nPlease sign in to set up your availability: '+SITE_URL+
    '\n\nUse the Coach login button at the top of the page.',86400*6))sent++;
  }catch(e){console.error('Coach nudge failed',e.message)}
 }
 return {sent,coachesChecked:coachesList.length};
}
async function dailyAutomation(token){
 const reminders=await sendDailyReminders(token);
 const coaches=await promptCoaches(token);
 const waitlist=await notifyWaitlist(token);
 return {ok:true,reminders,coaches,waitlist};
}

export default async function handler(req,res){
 const origin=String(req.headers.origin||'');
 if(origin && (ALLOWED_ORIGINS.has(origin)||isSameOrigin(origin,req))){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');}
 if(req.method==='OPTIONS')return res.statusCode=204,res.end();
 if(origin && !ALLOWED_ORIGINS.has(origin) && !isSameOrigin(origin,req))return json(res,403,{error:'Origin not allowed.'});
 try{
  const action=(req.method==='GET'?req.query.action:req.body?.action)||'';
  if(req.method==='GET'&&action==='health')return json(res,200,{ok:true,configured:!!(process.env.GOOGLE_REFRESH_TOKEN&&process.env.UPSTASH_REDIS_REST_TOKEN)});
  if(action==='automation'){
   if(req.method!=='GET'||!process.env.CRON_SECRET||!compare(clean(req.headers.authorization), 'Bearer '+process.env.CRON_SECRET))throw fail(401,'Unauthorized.');
   envCheck();const token=await googleToken();return json(res,200,await dailyAutomation(token));
  }
  envCheck();
  const token=await googleToken();
  const body=req.body||{};
  let value;
  if(req.method==='GET'&&action==='availability')value={slots:await available(token,durationOf(req.query.duration||60),null),timezone:TZ};
  else if(req.method==='POST'&&action==='book'){
   const client=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0];
   const rate='wp:booking-rate:'+sha(client).slice(0,32);
   const [attempts]=await redis([['INCR',rate],['EXPIRE',rate,3600]]);
   if(Number(attempts)>12)throw fail(429,'Too many booking attempts. Please try again later.');
   value=await booking(token,body);
  }
  else if(req.method==='POST'&&action==='requestCode')value=await requestCode(token,body,String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0]);
  else if(req.method==='POST'&&action==='verifyCode')value=await verifyCode(token,body);
  else if(req.method==='POST'&&action==='manageTimes')value=await rescheduleOptions(token,body);
  else if(req.method==='POST'&&action==='reschedule')value=await reschedule(token,body);
  else if(req.method==='POST'&&action==='coachRequestCode')value=await coachRequestCode(token,body,String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0]);
  else if(req.method==='POST'&&action==='coachVerifyCode')value=await coachVerifyCode(body);
  else if(req.method==='POST'&&action==='coachAvailability')value=await coachAvailability(token,body);
  else if(req.method==='POST'&&action==='coachAddWindow')value=await coachAddWindow(token,body);
  else if(req.method==='POST'&&action==='coachRemoveWindow')value=await coachRemoveWindow(token,body);
  else if(req.method==='POST'&&action==='coachSignOut')value=await coachSignOut(body);
  else if(req.method==='POST'&&action==='waitlistJoin')value=await joinWaitlist(token,body,String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0]);
  else if(req.method==='POST'&&action==='waitlistLeave')value=await unsubscribeWaitlist(token,body);
  else throw fail(404,'Unknown API endpoint.');
  return json(res,200,value);
 }catch(err){const status=err.status||500;console.error('API error',status,err.message);return json(res,status,{error:status===500?'Unexpected server error. Please try again.':err.message});}
}
