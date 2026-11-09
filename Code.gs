/**
 * Waterpolo Lesson Schedule — Apps Script backend.
 * Google Sheet: Waterpolo Lesson Schedule (existing sheet, not public).
 * Run setup() as the Google account owner, then deploy as a Web App.
 */
const SHEET_ID = '1ko_r6wSoerKj4XOKOPKHq7f4TFE9xlsqnJ7h00SwTK8';
const HEADERS = {
  Slots:['Slot ID','Date (YYYY-MM-DD)','Start (HH:MM)','End (HH:MM)','Location','Status','Booking ID'],
  Bookings:['Booking ID','Booked At','Slot ID','Lesson Date','Start','End','Kid Name','Parent Email','Phone','Location','Calendar Event ID','Status','Last Updated','Duration (minutes)']
};
function doGet(){return HtmlService.createHtmlOutputFromFile('Index').setTitle('Waterpolo Lesson Schedule').addMetaTag('viewport','width=device-width,initial-scale=1')}
function setup(){
 const book=SpreadsheetApp.openById(SHEET_ID);
 Object.keys(HEADERS).forEach(name=>{let tab=book.getSheetByName(name)||book.insertSheet(name);tab.getRange(1,1,1,HEADERS[name].length).setValues([HEADERS[name]]);tab.setFrozenRows(1)});
 let props=PropertiesService.getScriptProperties(), id=props.getProperty('CALENDAR_ID');
 let cal=id&&CalendarApp.getCalendarById(id);
 if(!cal){cal=CalendarApp.createCalendar('Waterpolo Lessons');props.setProperty('CALENDAR_ID',cal.getId())}
 Logger.log('Spreadsheet: '+book.getUrl());Logger.log('Lesson calendar ID: '+cal.getId());
 return 'Setup complete';
}
function sheet_(name){const tab=SpreadsheetApp.openById(SHEET_ID).getSheetByName(name);if(!tab)throw Error('Missing '+name+' tab. Run setup.');return tab}
function calendar_(){const id=PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');const cal=id&&CalendarApp.getCalendarById(id);if(!cal)throw Error('Run setup() to authorize the lesson calendar.');return cal}
function rows_(){return sheet_('Bookings').getDataRange().getDisplayValues().slice(1).map((a,i)=>({row:i+2,id:a[0],window:a[2],date:a[3],start:a[4],end:a[5],kid:a[6],email:a[7],phone:a[8],location:a[9],event:a[10],status:a[11],duration:Number(a[13])||30})).filter(x=>x.id&&x.status==='CONFIRMED')}
function windows_(){return sheet_('Slots').getDataRange().getDisplayValues().slice(1).map(a=>({id:a[0].trim(),date:a[1].trim(),start:a[2].trim(),end:a[3].trim(),location:a[4]||'Pool',status:a[5].toUpperCase(),legacy:a[6]})).filter(x=>x.id)}
function min_(s){const a=s.split(':').map(Number);return a[0]*60+a[1]}
function time_(m){return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0')}
function date_(day,time){return Utilities.parseDate(day+' '+time,Session.getScriptTimeZone(),'yyyy-MM-dd HH:mm')}
function duration_(x){const n=Number(x||30);if(n!==30&&n!==60)throw Error('Choose 30 or 60 minutes.');return n}
function options_(duration,excludeId){
 const current=rows_().filter(b=>b.id!==excludeId), now=new Date(),cal=calendar_(),windows=windows_(),slots=[];
 if(new Set(windows.map(w=>w.id)).size!==windows.length)throw Error('Duplicate Slot IDs found.');
 windows.forEach(w=>{
  if(w.status!=='OPEN'||w.legacy||!/^\\d{4}-\\d{2}-\\d{2}$/.test(w.date)||!/^\\d\\d:\\d\\d$/.test(w.start)||!/^\\d\\d:\\d\\d$/.test(w.end))return;
  const low=min_(w.start),high=min_(w.end);if(high<=low||high>1440)return;
  const busy=current.filter(x=>x.window===w.id&&x.date===w.date).map(x=>({a:min_(x.start),b:min_(x.end)})).sort((x,y)=>x.a-y.a);
  if(busy.some((x,i)=>i&&x.a!==busy[i-1].b))return;
  for(let m=low;m+duration<=high;m+=15){
   if(busy.length&&m+duration!==busy[0].a&&m!==busy[busy.length-1].b)continue;
   if(busy.some(x=>m<x.b&&m+duration>x.a))continue;
   let from=date_(w.date,time_(m)),to=date_(w.date,time_(m+duration));
   if(from<=now||from.getTime()-now.getTime()>120*86400000)continue;
   if(cal.getEvents(from,to).some(e=>e.getId()!==getEventId_(excludeId)&&e.getStartTime()<to&&e.getEndTime()>from))continue;
   slots.push({id:w.id+'@'+time_(m),windowId:w.id,date:w.date,start:time_(m),end:time_(m+duration),location:w.location});
  }
 });
 return slots.sort((a,b)=>(a.date+a.start).localeCompare(b.date+b.start))
}
function getEventId_(id){return (rows_().find(x=>x.id===id)||{}).event}
function listAvailableSlots(duration){duration=duration_(duration);return{slots:options_(duration,null),timezone:Session.getScriptTimeZone(),lessonMinutes:duration}}
function safe_(s){s=String(s||'').trim();return /^[=+@\\-\\t\\r]/.test(s)?"'"+s:s}
function bookLesson(f){
 const duration=duration_(f.duration),id=String(f.slotId||''),kid=String(f.kidName||'').trim(),email=String(f.email||'').trim().toLowerCase(),phone=String(f.phone||'').trim();
 if(kid.length<2||kid.length>100||!/^\\S+@\\S+\\.\\S+$/.test(email)||!/^[+\\d\\s().-]{7,24}$/.test(phone))throw Error('Complete the parent contact details and child name.');
 const lock=LockService.getScriptLock();if(!lock.tryLock(20000))throw Error('System busy; retry.');
 try{
  const slot=options_(duration,null).find(s=>s.id===id);if(!slot)throw Error('That lesson time is no longer available.');
  const bookingId=Utilities.getUuid(),cal=calendar_(),start=date_(slot.date,slot.start),end=date_(slot.date,slot.end);
  const event=cal.createEvent('Waterpolo Lesson — '+kid,start,end,{guests:email,sendInvites:true,location:slot.location,description:'Child: '+kid+'\\nPhone: '+phone+'\\nBooking ID: '+bookingId});
  try{sheet_('Bookings').appendRow([bookingId,new Date(),slot.windowId,slot.date,slot.start,slot.end,safe_(kid),safe_(email),safe_(phone),safe_(slot.location),event.getId(),'CONFIRMED',new Date(),duration]);SpreadsheetApp.flush()}
  catch(e){try{event.deleteEvent()}catch(_){}throw Error('Could not save booking. Contact instructor before retrying.')}
  return{bookingId,date:slot.date,start:slot.start,end:slot.end,duration,location:slot.location,timezone:Session.getScriptTimeZone(),email};
 }finally{lock.releaseLock()}
}
function norm_(phone,kid){let p=String(phone||'').replace(/\\D/g,''),k=String(kid||'').trim().replace(/\\s+/g,' ').toLowerCase();if(p.length<7||p.length>15||k.length<2)throw Error('Enter phone and child name.');return {phone:p,kid:k}}
function matching_(ident){return rows_().filter(r=>r.phone.replace(/\\D/g,'')===ident.phone&&r.kid.trim().replace(/\\s+/g,' ').toLowerCase()===ident.kid)}
function hash_(s){return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,s))}
function requestManageCode(f){
 const ident=norm_(f.phone,f.kidName), matches=matching_(ident);
 // Do not reveal whether a phone/child combination is registered.
 if(!matches.length)return {message:'If a booking was found, a verification code was sent.'};
 const addresses=[...new Set(matches.map(x=>x.email).filter(Boolean))];if(addresses.length!==1)throw Error('Contact instructor to manage this booking.');
 const key=hash_(ident.phone+'|'+ident.kid),code=String(Math.floor(100000+Math.random()*900000));
 const cache=CacheService.getScriptCache();cache.put('verify:'+key,hash_(code),600);cache.remove('access:'+key);
 MailApp.sendEmail(addresses[0],'Your Waterpolo Lesson verification code','Your verification code is '+code+'. It expires in 10 minutes. If you did not request this, ignore this email.');
 return{message:'If a booking was found, a verification code was sent.'};
}
function verifyManageCode(f){
 const ident=norm_(f.phone,f.kidName),key=hash_(ident.phone+'|'+ident.kid),attempt=hash_(String(f.code||'').trim()),cache=CacheService.getScriptCache();
 if(!cache.get('verify:'+key)||cache.get('verify:'+key)!==attempt)throw Error('Incorrect or expired verification code.');
 cache.remove('verify:'+key);const token=Utilities.getUuid();cache.put('access:'+key,hash_(token),1800);
 return {token,bookings:matching_(ident).map(public_)};
}
function public_(r){return{bookingId:r.id,date:r.date,start:r.start,end:r.end,location:r.location,duration:r.duration}}
function auth_(f){
 const ident=norm_(f.phone,f.kidName),key=hash_(ident.phone+'|'+ident.kid),token=String(f.token||''),stored=CacheService.getScriptCache().get('access:'+key);
 if(!token||!stored||stored!==hash_(token))throw Error('Verification expired. Request a new code.');
 return ident;
}
function listRescheduleOptions(f){
 const ident=auth_(f),b=matching_(ident).find(x=>x.id===String(f.bookingId||''));if(!b)throw Error('Booking not found.');
 return {slots:rescheduleOptions_(b)};
}
function rescheduleOptions_(b){
 const old=rows_().filter(r=>r.id!==b.id&&r.window===b.window&&r.date===b.date).sort((a,z)=>min_(a.start)-min_(z.start));
 if(old.some((x,i)=>i&&x.start!==old[i-1].end))throw Error('This booking joins two lessons. Contact instructor to reschedule.');
 return options_(b.duration,b.id).filter(s=>!(s.windowId===b.window&&s.date===b.date&&s.start===b.start));
}
function rescheduleLesson(f){
 const ident=auth_(f),lock=LockService.getScriptLock();if(!lock.tryLock(20000))throw Error('System busy; retry.');
 try{
  const b=matching_(ident).find(x=>x.id===String(f.bookingId||''));if(!b)throw Error('Booking no longer found.');
  const slot=rescheduleOptions_(b).find(s=>s.id===String(f.slotId||''));if(!slot)throw Error('That time is no longer available.');
  const event=calendar_().getEventById(b.event);if(!event)throw Error('Calendar event missing; contact instructor.');
  const oldStart=event.getStartTime(),oldEnd=event.getEndTime(),oldLocation=event.getLocation();
  event.setTime(date_(slot.date,slot.start),date_(slot.date,slot.end));
  try{
   const sh=sheet_('Bookings');sh.getRange(b.row,3,1,4).setValues([[slot.windowId,slot.date,slot.start,slot.end]]);sh.getRange(b.row,10).setValue(safe_(slot.location));sh.getRange(b.row,13).setValue(new Date());event.setLocation(slot.location);SpreadsheetApp.flush();
  }catch(e){try{event.setTime(oldStart,oldEnd);event.setLocation(oldLocation)}catch(_){}throw Error('Unable to update booking. Contact instructor.')}
  return{booking:{bookingId:b.id,date:slot.date,start:slot.start,end:slot.end,location:slot.location,duration:b.duration}};
 }finally{lock.releaseLock()}
}
