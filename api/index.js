import crypto from 'node:crypto';

const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1ko_r6wSoerKj4XOKOPKHq7f4TFE9xlsqnJ7h00SwTK8';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const TZ = process.env.LESSON_TIMEZONE || 'America/Los_Angeles';
const ORIGIN = process.env.SITE_ORIGIN || 'https://ecetabag.github.io';
const ALLOWED_ORIGINS = new Set([ORIGIN, ...(process.env.ADDITIONAL_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)]);
const DURATIONS = new Set([60, 90]);
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
function windowsRows(data){return data.map(a=>({id:clean(a[0]),date:clean(a[1]),start:clean(a[2]),end:clean(a[3]),location:clean(a[4])||'Pool',status:clean(a[5]).toUpperCase(),legacy:clean(a[6]),coachEmail:clean(a[7]).toLowerCase()})).filter(w=>w.id && w.status==='OPEN' && !w.legacy && validDay(w.date) && validClock(w.start) && validClock(w.end) && minutes(w.end)>minutes(w.start));}
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
 await mail(token,email,'Your Waterpolo coach sign-in code','Your coach sign-in code is '+code+'. It expires in 10 minutes. If you did not request this, ignore this email.');
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
 const day=clean(data.date),start=clean(data.start),end=clean(data.end),location=clean(data.location)||'Pool';
 if(!validDay(day)||!validClock(start)||!validClock(end))throw fail(400,'Choose a valid date and time.');
 if(minutes(end)<=minutes(start)||minutes(end)-minutes(start)<60||minutes(end)-minutes(start)>720)throw fail(400,'Teaching windows must be between 1 and 12 hours.');
 if(location.length>120)throw fail(400,'Location is too long.');
 if(instant(day,start).getTime()<=Date.now())throw fail(400,'Choose a future availability window.');
 if(instant(day,start).getTime()>Date.now()+120*86400000)throw fail(400,'Availability may be added up to 120 days ahead.');
 return lockDay(day,async()=>{
  const rows=windowsRows(await readRows(token,WINDOWS));
  if(rows.some(w=>w.date===day&&minutes(start)<minutes(w.end)&&minutes(end)>minutes(w.start)))throw fail(409,'This teaching window overlaps another open window.');
  const windowId='WP-'+crypto.randomUUID().slice(0,12).toUpperCase();
  await sheets(token,'POST',"'Slots'!A:H",{values:[[windowId,day,start,end,safe(location),'OPEN','',coach]]},{valueInputOption:'RAW',insertDataOption:'INSERT_ROWS'});
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
async function mail(token,to,subject,body) {
 const message=['To: '+to,'Subject: '+subject,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','',''+body].join('\r\n');
 const raw=Buffer.from(message).toString('base64url');
 await google(token,'POST','https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{raw});
}
async function booking(token,data) {
 const duration=durationOf(data.duration),slotId=clean(data.slotId),kid=clean(data.kidName),email=clean(data.email).toLowerCase(),phone=clean(data.phone);
 if(kid.length<2||kid.length>100||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!/^[+\d\s().-]{7,24}$/.test(phone))throw fail(400,'Enter the child name, a valid email, and phone number.');
 const requestedDay=slotId.split('@')[0]; // Lookup actual window ID below; IDs need not be dates.
 const windows=windowsRows(await readRows(token,WINDOWS));const window=windows.find(w=>w.id===requestedDay);
 if(!window)throw fail(409,'That appointment is no longer available.');
 return lockDay(window.date,async()=>{
  const slot=(await available(token,duration,null)).find(s=>s.id===slotId);
  if(!slot)throw fail(409,'That appointment is no longer available.');
  const bookingId=crypto.randomUUID().replaceAll('-',''),eventId=bookingId;
  const start=instant(slot.date,slot.start),end=instant(slot.date,slot.end);
  const event={id:eventId,summary:'Water polo lesson — '+kid,location:slot.location,description:'Booking ID: '+bookingId, start:{dateTime:start.toISOString(),timeZone:TZ},end:{dateTime:end.toISOString(),timeZone:TZ},attendees:[{email}]};
  await google(token,'POST',calendarPath(),event,{sendUpdates:'all'});
  try{
   const values=[[bookingId,new Date().toISOString(),slot.windowId,slot.date,slot.start,slot.end,safe(kid),email,safe(phone),safe(slot.location),eventId,'CONFIRMED',new Date().toISOString(),duration]];
   await sheets(token,'POST',"'Bookings'!A:N",{values},{valueInputOption:'RAW',insertDataOption:'INSERT_ROWS'});
  }catch(e){await google(token,'DELETE',calendarPath()+'/'+eventId).catch(()=>{});throw e;}
  return {bookingId,date:slot.date,start:slot.start,end:slot.end,duration,location:slot.location,timezone:TZ};
 });
}
async function findBookings(token,phone,kid) {
 const rows=bookingRows(await readRows(token,BOOKINGS));
 return rows.filter(b=>normalizePhone(b.phone)===normalizePhone(phone)&&normalizeKid(b.kid)===normalizeKid(kid)&&instant(b.date,b.start).getTime()>Date.now());
}
const identity = data => {
 const phone=normalizePhone(data.phone),kid=normalizeKid(data.kidName);
 if(phone.length<7||phone.length>15||kid.length<2||kid.length>100)throw fail(400,'Enter a valid phone number and child name.');
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
  await mail(token,matches[0].email,'Your water polo booking verification code','Your code is '+code+'. It expires in 10 minutes. If you did not request this, ignore this message.');
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
 if(!destination)throw fail(409,'That appointment is no longer available.');
 // Lock both dates in deterministic order to prevent races and preserve the adjacency rule.
 const keys=[...new Set([booking.date,destination.date])].sort();
 const run=async i=>i===keys.length?await move():lockDay(keys[i],()=>run(i+1));
 const move=async()=>{
  const current=await authorized(token,data);
  const options=await available(token,current.duration,current.id),slot=options.find(s=>s.id===requested);
  if(!slot)throw fail(409,'That time is no longer available.');
  const before=await google(token,'GET',calendarPath()+'/'+encodeURIComponent(current.event));
  const start=instant(slot.date,slot.start),end=instant(slot.date,slot.end);
  await google(token,'PATCH',calendarPath()+'/'+encodeURIComponent(current.event),{start:{dateTime:start.toISOString(),timeZone:TZ},end:{dateTime:end.toISOString(),timeZone:TZ},location:slot.location},{sendUpdates:'all'});
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
   await google(token,'PATCH',calendarPath()+'/'+encodeURIComponent(current.event),{start:before.start,end:before.end,location:before.location},{sendUpdates:'all'}).catch(()=>{});
   throw e;
  }
  return {booking:{bookingId:current.id,date:slot.date,start:slot.start,end:slot.end,duration:current.duration}};
 };
 return run(0);
}

export default async function handler(req,res){
 const origin=String(req.headers.origin||'');
 if(origin && (ALLOWED_ORIGINS.has(origin)||isSameOrigin(origin,req))){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');}
 if(req.method==='OPTIONS')return res.statusCode=204,res.end();
 if(origin && !ALLOWED_ORIGINS.has(origin) && !isSameOrigin(origin,req))return json(res,403,{error:'Origin not allowed.'});
 try{
  const action=(req.method==='GET'?req.query.action:req.body?.action)||'';
  if(req.method==='GET'&&action==='health')return json(res,200,{ok:true,configured:!!(process.env.GOOGLE_REFRESH_TOKEN&&process.env.UPSTASH_REDIS_REST_TOKEN)});
  envCheck();
  const token=await googleToken();
  const body=req.body||{};
  let value;
  if(req.method==='GET'&&action==='availability')value={slots:await available(token,durationOf(req.query.duration||30),null),timezone:TZ};
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
  else throw fail(404,'Unknown API endpoint.');
  return json(res,200,value);
 }catch(err){const status=err.status||500;console.error('API error',status,err.message);return json(res,status,{error:status===500?'Unexpected server error. Please try again.':err.message});}
}
