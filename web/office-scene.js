/* Office scene: visual effects consume real events; preview never writes business data. */
(() => {
  'use strict';
  const labels={message_take:'领取消息',message_finish:'反馈处理结果',inform:'通知',request:'请求答复',reply:'回复',read:'阅读消息',accepted:'整理收件箱',item_claim:'领取任务',item_submit:'提交材料',item_verify:'反馈结果',item_create:'安排任务',item_renew:'续租',wait_pose:'等待消息',rest_pose:'休息',work_pose:'处理事情',celebrate_pose:'庆祝（演示）',message:'发送消息',message_read:'阅读消息',message_archive:'整理收件箱',material_read:'阅读材料',material_published:'放好材料',container:'整理容器',progress:'报告进展',claim:'领取工作',submit:'提交材料',verify:'反馈结果'};
  // Original vector character/animation; references inform proportions and timing, not copied artwork.
  const neutral={headTilt:0,headX:0,headY:0,leftArm:0,rightArm:0,bodyTilt:0,bodyY:0,bodyScale:1,propY:0,propTilt:0,propOpacity:0,eyes:1,page:1,expression:'calm'};
  const sequence=(id,label,stages,beats)=>({id,label,stages,keyframes:[{at:0,...neutral},...beats.map(([at,frame])=>({at,...neutral,propOpacity:1,...frame})),{at:1,...neutral}]});
  const catalog={
    reading:[
      sequence('book','翻阅资料',['打开资料','翻页查看','合上资料'],[[.15,{leftArm:-28,rightArm:26,headTilt:6,propY:3}],[.35,{leftArm:-24,rightArm:44,headTilt:9,page:.1,eyes:.8}],[.55,{leftArm:-28,rightArm:18,headTilt:-5,page:-1}],[.75,{leftArm:-26,rightArm:32,headTilt:4,page:1}],[.9,{leftArm:-12,rightArm:12,headTilt:0,propY:6,propOpacity:.5}]]),
      sequence('screen','对照屏幕',['靠近屏幕','左右核对','坐回椅背'],[[.15,{headY:1,headX:3,leftArm:-15,rightArm:25,expression:'focus'}],[.35,{headX:4,headTilt:7,rightArm:40,eyes:.8,expression:'focus'}],[.55,{headX:-2,headTilt:-5,leftArm:-24,rightArm:18,expression:'curious'}],[.75,{headTilt:3,headY:2,rightArm:30,expression:'happy'}],[.9,{headY:-1,bodyTilt:-3,propOpacity:.4}]]),
      sequence('note','摘记重点',['拿出便签','圈出重点','收好便签'],[[.15,{leftArm:-32,rightArm:24,headTilt:6,propTilt:-4}],[.35,{leftArm:-26,rightArm:42,headY:2,expression:'focus',propTilt:3}],[.55,{leftArm:-32,rightArm:28,headTilt:-3,propTilt:-3,expression:'focus'}],[.75,{leftArm:-28,rightArm:42,headTilt:3,propTilt:2}],[.9,{leftArm:-14,rightArm:12,propY:5,propOpacity:.5,expression:'happy'}]])
    ],
    working:[
      sequence('typing','敲键盘',['抬手准备','交替键入','停手检查'],[[.15,{leftArm:-24,rightArm:24,headTilt:3,expression:'focus'}],[.3,{leftArm:-42,rightArm:18,bodyY:1,headY:1,expression:'focus'}],[.45,{leftArm:-18,rightArm:42,bodyY:0,headTilt:-3,expression:'focus'}],[.6,{leftArm:-42,rightArm:18,headTilt:3,expression:'focus'}],[.75,{leftArm:-18,rightArm:42,bodyY:1,expression:'focus'}],[.9,{leftArm:-12,rightArm:12,headY:-2,expression:'happy'}]]),
      sequence('write','写工作笔记',['打开本子','落笔书写','抬头检查'],[[.15,{leftArm:-22,rightArm:30,headY:2,propY:1,expression:'focus'}],[.35,{leftArm:-22,rightArm:49,headTilt:8,propTilt:4,expression:'focus'}],[.55,{leftArm:-24,rightArm:32,headTilt:4,propTilt:-2,expression:'focus'}],[.75,{leftArm:-24,rightArm:47,headTilt:8,propTilt:3}],[.9,{headY:-2,leftArm:-10,rightArm:10,propOpacity:.5,expression:'happy'}]]),
      sequence('think','思考点子',['托腮思考','歪头琢磨','想到点子'],[[.15,{rightArm:-115,headTilt:8,expression:'curious'}],[.35,{rightArm:-125,headTilt:13,eyes:.7,expression:'curious'}],[.55,{rightArm:-115,headTilt:-9,expression:'curious'}],[.75,{rightArm:-55,headY:-3,headTilt:0,bodyScale:1.03,expression:'surprised',propY:-2}],[.9,{rightArm:-20,expression:'happy',propOpacity:.6}]])
    ],
    waiting:[
      sequence('sip','喝口水',['捧起杯子','小口喝水','放下杯子'],[[.15,{rightArm:-35,leftArm:-12,propY:10,expression:'happy'}],[.35,{rightArm:-100,leftArm:-20,headTilt:-5,propY:-3,eyes:.8}],[.55,{rightArm:-105,leftArm:-20,headTilt:-8,propY:-4,eyes:.5}],[.75,{rightArm:-60,propY:3,expression:'happy'}],[.9,{rightArm:-15,propY:11,propOpacity:.4}]]),
      sequence('watch','看看时间',['抬起手腕','低头看看','放手继续等'],[[.15,{leftArm:55,headTilt:-3}],[.35,{leftArm:92,headTilt:-10,headY:2,expression:'curious'}],[.55,{leftArm:88,headTilt:-7,eyes:.7,expression:'curious'}],[.75,{leftArm:60,headTilt:4}],[.9,{leftArm:15,expression:'calm',propOpacity:.3}]]),
      sequence('stretch','活动肩膀',['抬起双臂','左右舒展','放松肩膀'],[[.15,{leftArm:55,rightArm:-55,headY:-1}],[.35,{leftArm:125,rightArm:-120,headTilt:-8,bodyTilt:-4,eyes:.4,expression:'happy'}],[.55,{leftArm:118,rightArm:-125,headTilt:8,bodyTilt:4,eyes:.4,expression:'happy'}],[.75,{leftArm:90,rightArm:-85,headY:-2,expression:'happy'}],[.9,{leftArm:20,rightArm:-20,bodyY:1}]])
    ],
    resting:[
      sequence('doze','打个小盹',['慢慢闭眼','轻轻点头','睁眼醒来'],[[.15,{headTilt:5,eyes:.6,bodyTilt:-2,expression:'sleepy'}],[.35,{headY:3,headTilt:9,eyes:.04,expression:'sleepy'}],[.55,{headY:1,headTilt:6,eyes:.04,bodyScale:1.02,expression:'sleepy'}],[.75,{headY:3,headTilt:10,eyes:.04,expression:'sleepy'}],[.9,{headY:-2,headTilt:0,eyes:.85,expression:'surprised',propOpacity:.2}]]),
      sequence('headphones','听会儿音乐',['戴好耳机','随音乐点头','摘下耳机'],[[.15,{leftArm:95,rightArm:-95,headTilt:-3}],[.35,{leftArm:5,rightArm:-5,headTilt:8,eyes:.6,expression:'happy'}],[.55,{headTilt:-8,bodyTilt:-2,eyes:.7,expression:'happy'}],[.75,{headTilt:7,bodyTilt:2,eyes:.6,expression:'happy'}],[.9,{leftArm:80,rightArm:-80,propOpacity:.5,expression:'happy'}]]),
      sequence('relax','靠椅放松',['向后靠一靠','放松呼吸','慢慢坐正'],[[.15,{bodyTilt:-4,headTilt:-5,leftArm:12,rightArm:-12,expression:'happy'}],[.35,{bodyTilt:-6,headY:-1,eyes:.55,bodyScale:1.03,expression:'happy'}],[.55,{bodyTilt:-6,headTilt:5,eyes:.45,bodyScale:1,expression:'happy'}],[.75,{bodyTilt:-4,headTilt:-3,eyes:.7,bodyScale:1.02}],[.9,{bodyTilt:-1,headTilt:0}]])
    ],
    communicating:[
      sequence('wave','挥手招呼',['抬手招呼','挥挥小手','放手微笑'],[[.15,{rightArm:-70,headTilt:-4,expression:'happy'}],[.3,{rightArm:-140,headTilt:6,expression:'happy'}],[.45,{rightArm:-105,headTilt:-4,expression:'happy'}],[.6,{rightArm:-140,headTilt:6,expression:'happy'}],[.75,{rightArm:-105,headTilt:0,expression:'happy'}],[.9,{rightArm:-35,expression:'happy'}]]),
      sequence('letter','递交信件',['双手拿信','递向同事','收回双手'],[[.15,{leftArm:-28,rightArm:28,propY:4,expression:'happy'}],[.35,{leftArm:-44,rightArm:44,propY:-2,headY:1,expression:'happy'}],[.55,{leftArm:-50,rightArm:50,propY:-4,headTilt:5,expression:'happy'}],[.75,{leftArm:-35,rightArm:35,propY:0,expression:'happy'}],[.9,{leftArm:-8,rightArm:8,propY:7,propOpacity:.3}]]),
      sequence('nod','点头回应',['看向同事','点头回应','微笑示意'],[[.15,{headY:-2,headTilt:-2,expression:'happy'}],[.35,{headY:3,headTilt:5,eyes:.6,expression:'happy'}],[.55,{headY:-2,headTilt:0,expression:'happy'}],[.75,{headY:3,headTilt:5,eyes:.8,expression:'happy'}],[.9,{headY:0,rightArm:-25,expression:'happy'}]])
    ],
    celebrating:[
      sequence('cheer','举手欢呼',['开心蓄势','双手欢呼','收手坐稳'],[[.15,{leftArm:25,rightArm:-25,headY:2,bodyScale:.97,expression:'happy'}],[.35,{leftArm:145,rightArm:-145,headY:-3,bodyScale:1.04,expression:'joy'}],[.55,{leftArm:120,rightArm:-120,headTilt:-7,expression:'joy'}],[.75,{leftArm:145,rightArm:-145,headTilt:7,bodyScale:1.03,expression:'joy'}],[.9,{leftArm:40,rightArm:-40,expression:'happy',propOpacity:.4}]]),
      sequence('clap','拍拍手',['抬起双手','开心鼓掌','放手微笑'],[[.15,{leftArm:-25,rightArm:25,expression:'happy'}],[.3,{leftArm:-65,rightArm:65,expression:'joy',propOpacity:1}],[.45,{leftArm:-35,rightArm:35,headTilt:4,propOpacity:.2,expression:'happy'}],[.6,{leftArm:-65,rightArm:65,propOpacity:1,expression:'joy'}],[.75,{leftArm:-35,rightArm:35,headTilt:-4,propOpacity:.2,expression:'happy'}],[.9,{leftArm:-10,rightArm:10,expression:'happy',propOpacity:0}]]),
      sequence('thumbsup','竖起拇指',['抬起小手','点赞肯定','放下手臂'],[[.15,{rightArm:-25,headTilt:3,propY:8,expression:'happy'}],[.35,{rightArm:-65,headTilt:-5,propY:-2,expression:'joy'}],[.55,{rightArm:-70,headY:2,propY:-3,expression:'happy'}],[.75,{rightArm:-65,headY:-1,propY:-2,expression:'happy'}],[.9,{rightArm:-15,propY:8,propOpacity:.3}]])
    ]
  };
  const actions=Object.fromEntries(Object.values(catalog).flat().map(a=>[a.id,a]));
  function sampleAction(id,progress){
    const frames=actions[id].keyframes,p=Math.max(0,Math.min(1,progress));
    const index=frames.findIndex(f=>f.at>=p),b=frames[Math.max(0,index)],a=frames[Math.max(0,index-1)];
    const raw=b.at===a.at?1:(p-a.at)/(b.at-a.at),t=raw*raw*(3-2*raw),result={};
    for(const key of Object.keys(neutral))result[key]=typeof a[key]==='number'?a[key]+(b[key]-a[key])*t:(t<.5?a[key]:b[key]);
    return result;
  }
  function drawAction(person,frame){
    for(const [key,value] of Object.entries(frame))if(key!=='expression')person.style.setProperty('--pose-'+key,String(value));
    person.dataset.expression=frame.expression;
  }
  function clearAction(person){delete person.dataset.pose;delete person.dataset.idle;person.dataset.facing='down';person.dataset.posture='seated';drawAction(person,neutral);}
  const stateFor=kind=>['material_read','message_read','read'].includes(kind)?'reading':['wait_pose','wait_started'].includes(kind)?'waiting':kind==='rest_pose'?'resting':kind==='celebrate_pose'?'celebrating':['message','inform','request','reply','message_finish'].includes(kind)?'communicating':'working';
  function props(person){
    const station=document.createElement('span');station.className='office-workstation';station.setAttribute('aria-hidden','true');
    // All markup here is fixed geometry. User names/content are rendered through textContent elsewhere.
    station.innerHTML=`<span class="office-chair"><svg viewBox="0 0 72 76"><path d="M36 39v26m0-4L13 69m23-8 23 8m-23-8-3 11" stroke="#516565" stroke-width="4" stroke-linecap="round"/><g fill="#364b4c"><rect x="8" y="67" width="10" height="6" rx="3"/><rect x="54" y="67" width="10" height="6" rx="3"/><rect x="28" y="69" width="10" height="6" rx="3"/></g><rect x="7" y="8" width="58" height="29" rx="10" fill="#516f70" stroke="#3f5a5b" stroke-width="2"/><path d="M17 16h38m-38 7h38m-38 7h38" stroke="#7e9895" stroke-width="2" opacity=".6"/><path d="M10 36h52q7 0 6 7H8q-1-7 2-7" fill="#77938d" stroke="#4d6b67" stroke-width="2"/><path d="M5 26v16m62-16v16" stroke="#405b58" stroke-width="4" stroke-linecap="round"/></svg></span><span class="office-furniture"><svg viewBox="0 0 280 190" width="280" height="190" preserveAspectRatio="xMidYMid meet">
      <ellipse cx="140" cy="153" rx="91" ry="4" fill="#647f73" opacity=".12"/>
      <g class="office-table" transform="translate(-43 -30)">
        <rect x="107" y="143" width="10" height="37" rx="3" fill="#8a9b91"/><rect x="249" y="143" width="10" height="37" rx="3" fill="#758d82"/>
        <path d="M117 150h132" stroke="#b58c65" stroke-width="5"/>
        <path d="M92 129q0 9 9 9h164q9 0 9-9v13q0 8-9 8H101q-9 0-9-8z" fill="#caa276" stroke="#b78e66" stroke-width="1.5"/>
        <path d="M101 106h164q9 0 9 9v14q0 9-9 9H101q-9 0-9-9v-14q0-9 9-9z" fill="#efd3aa" stroke="#d0ad82" stroke-width="1.5"/>
        <path d="M101 109h162" stroke="#fae7c9" stroke-width="2" stroke-linecap="round"/><path d="M102 139h162" stroke="#b98e65" stroke-width="1.3" opacity=".5"/>
      </g>
      <g class="office-desk-pad" transform="translate(-28 -28)"><rect x="216" y="121" width="29" height="14" rx="4" fill="#a7bfb0"/><rect x="225" y="123" width="9" height="10" rx="4.5" fill="#ecede3" stroke="#92a69b"/><path d="M229.5 124v3" stroke="#9faf9f" stroke-width="1"/></g>
      <g class="office-keyboard" transform="translate(-41 -28)"><rect x="149" y="122" width="64" height="13" rx="3" fill="#c0cfc2"/><rect x="151" y="120" width="60" height="12" rx="3" fill="#f4f1e5" stroke="#b6c4b6" stroke-width="1"/>
        <path d="M155 124h52m-52 4h52M159 122v6m6-6v6m6-6v6m6-6v6m6-6v6m6-6v6m6-6v6m6-6v6" fill="none" stroke="#a7b9ab" stroke-width="1"/><path d="M169 130h23" stroke="#b0bfb0" stroke-width="1.5" stroke-linecap="round"/>
      </g>
      <g class="office-monitor" transform="translate(-41 -34)">
        <ellipse cx="181" cy="117" rx="20" ry="2.5" fill="#6c8b7b" opacity=".15"/>
        <rect class="office-monitor-stem" x="177" y="94" width="8" height="20" rx="2" fill="#839b90"/><path d="M179 96v16" stroke="#b4c4b6" stroke-width="1.5"/>
        <rect class="office-monitor-base" x="165" y="111" width="32" height="6" rx="3" fill="#92a99b"/><path d="M169 112h24" stroke="#bdcdbb" stroke-width="1.4" stroke-linecap="round"/>
        <rect class="office-monitor-frame" x="149" y="54" width="64" height="43" rx="5" fill="#506e65"/><rect x="152" y="57" width="58" height="35" rx="3" fill="#334f49"/><rect class="office-screen" x="155" y="60" width="52" height="28" rx="2" fill="#9abeb0"/>
        <rect x="159" y="64" width="44" height="4" rx="1" fill="#d8e7cf" opacity=".75"/><rect x="159" y="72" width="25" height="2" rx="1" fill="#e9f0dc" opacity=".65"/><rect x="159" y="77" width="35" height="2" rx="1" fill="#d6e7ce" opacity=".6"/><circle cx="181" cy="94.5" r="1" fill="#b8d1b8"/>
      </g>
      <g class="office-cup" transform="translate(-58 -29)"><ellipse cx="135" cy="134" rx="10" ry="2" fill="#819c87" opacity=".14"/><path d="M140 119h3q7 0 3 7h-5" fill="none" stroke="#81a99b" stroke-width="2.5"/><path d="M128 116h13v14q-6.5 7-13 0z" fill="#aecbb8" stroke="#84a995" stroke-width="1.2"/><ellipse cx="134.5" cy="116" rx="6.5" ry="2.5" fill="#dde5cc" stroke="#84a995" stroke-width="1"/><ellipse cx="134.5" cy="116" rx="4.5" ry="1.3" fill="#a58b6b"/></g>
      <g class="office-task-light" transform="translate(-36 -30)"><ellipse cx="254" cy="117" rx="16" ry="2.5" fill="#819b81" opacity=".14"/><rect x="240" y="112" width="28" height="5" rx="2.5" fill="#9faf8c"/>
        <path d="M253 112V86l8-10" fill="none" stroke="#8c9f81" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="253" cy="86" r="3" fill="#b9c6a7"/>
        <path d="M246 66h17l7 12h-31z" fill="#b5c5a1" stroke="#93a784" stroke-width="1.3" stroke-linejoin="round"/><path d="M242 78h25" stroke="#e4e8c3" stroke-width="2" stroke-linecap="round"/>
      </g>
    </svg></span><span class="office-paper-stack"></span>`;
    person.dataset.posture='seated';person.dataset.facing='down';
    person.innerHTML=`<svg viewBox="0 0 66 94" aria-hidden="true">
      <ellipse class="avatar-shadow" cx="33" cy="90" rx="20" ry="3" fill="#70877a" opacity=".16"/>
      <g class="avatar-standing-legs"><g class="avatar-leg left"><path d="M25 75v11" stroke="#586477" stroke-width="10" stroke-linecap="round"/><path d="M21 88h12" stroke="#f6e4c7" stroke-width="7" stroke-linecap="round"/></g><g class="avatar-leg right"><path d="M42 75v11" stroke="#48566a" stroke-width="10" stroke-linecap="round"/><path d="M38 88h12" stroke="#efdbbd" stroke-width="7" stroke-linecap="round"/></g></g>
      <g class="avatar-seated-legs"><path d="M24 75v11" stroke="#586477" stroke-width="10" stroke-linecap="round"/><path d="M42 75v11" stroke="#48566a" stroke-width="10" stroke-linecap="round"/><path d="M18 89h12m7 0h12" stroke="#f3dfbf" stroke-width="6" stroke-linecap="round"/></g>
      <g class="avatar-torso"><path d="M19 57q14-8 28 0l3 16q-17 11-34 0z" fill="currentColor" stroke="#516c6225" stroke-width="1"/><path d="M25 55q8 9 16 0" fill="none" stroke="#f8f3df" stroke-width="4" stroke-linecap="round"/><path d="M27 68h13v6H27z" fill="#fff" opacity=".13"/><path d="M29 58v7m8-7v7" stroke="#f4ecda" stroke-width="1.5" stroke-linecap="round"/>
      <g class="avatar-arm left"><path d="M19 60q-7 4-7 12" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round"/><circle cx="12" cy="73" r="4.8" fill="#f3c9a8"/></g><g class="avatar-arm right"><path d="M47 60q7 4 7 12" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round"/><circle cx="54" cy="73" r="4.8" fill="#f3c9a8"/></g></g>
      <g class="avatar-desk-torso"><path d="M18 56q15-8 30 0l4 21q-19 10-38 0z" fill="currentColor"/><path d="M23 56q10 8 20 0v9q-10 5-20 0z" fill="#fff" opacity=".18"/><path d="M33 67v12" stroke="#52776a" stroke-width="1.5" opacity=".4"/></g>
      <g class="avatar-head"><ellipse cx="11" cy="34" rx="4.5" ry="6" fill="#efbd99"/><ellipse cx="55" cy="34" rx="4.5" ry="6" fill="#efbd99"/><path class="avatar-hair avatar-bob" d="M9 25Q7 2 33 2q25 0 24 25l3 27-15-2H17L6 54z"/>
      <ellipse cx="33" cy="31" rx="23" ry="24" fill="#f8d9b9"/><path class="avatar-hair avatar-fringe" d="M10 30Q5 3 31 2q27-1 26 29l-7-9-6-9q-8 12-22 9l-8 12z"/><path class="avatar-hair avatar-curl" d="M10 31Q4 19 12 13Q7 6 19 6Q23-3 32 4q10-7 16 3 13-2 11 11l-4 14-8-13-5 6-8-8-12 8-5-5z"/><path class="avatar-hair avatar-short" d="M9 29Q6 4 30 3q26-3 28 26l-9-9-5-9q-11 13-30 11l-2 12z"/>
      <path class="avatar-hair-shine" d="M16 13q9-7 19-5" stroke="#fff" opacity=".15" stroke-width="4" fill="none" stroke-linecap="round"/>
      <g class="avatar-eyes"><ellipse cx="24" cy="33" rx="3.7" ry="5" fill="#4d4c59"/><ellipse cx="42" cy="33" rx="3.7" ry="5" fill="#4d4c59"/><circle cx="23" cy="31.5" r="1.3" fill="#fff"/><circle cx="41" cy="31.5" r="1.3" fill="#fff"/></g>
      <g class="avatar-blush" fill="#eea99f" opacity=".65"><ellipse cx="17" cy="41" rx="4.2" ry="2.5"/><ellipse cx="49" cy="41" rx="4.2" ry="2.5"/></g>
      <path class="avatar-mouth calm" d="M29 44q4 4 8 0" fill="none" stroke="#b27c70" stroke-width="1.8" stroke-linecap="round"/><path class="avatar-mouth happy" d="M27 43q6 11 12 0z" fill="#bf8379"/><path class="avatar-mouth joy" d="M26 42q7 15 14 0z" fill="#bc7b76"/><path class="avatar-mouth focus" d="M30 45h6" stroke="#b27c70" stroke-width="1.8" stroke-linecap="round"/><ellipse class="avatar-mouth surprised" cx="33" cy="45" rx="3" ry="3.7" fill="#bf8379"/><path class="avatar-mouth curious" d="M29 46q4-3 8 0" stroke="#b27c70" stroke-width="1.8" fill="none" stroke-linecap="round"/><path class="avatar-mouth sleepy" d="M30 45q3 2 6 0" stroke="#b27c70" stroke-width="1.8" fill="none" stroke-linecap="round"/>
      <g class="avatar-glasses" fill="none" stroke="#657a82" stroke-width="1.8"><rect x="17" y="27" width="13" height="12" rx="5"/><rect x="36" y="27" width="13" height="12" rx="5"/><path d="M30 32h6"/></g><g class="avatar-bow" fill="#e6a6a9"><path d="M45 8Q54-1 53 12q12-1 3 7z"/><circle cx="51" cy="12" r="3" fill="#c98997"/></g>
      <g class="avatar-back-head"><ellipse cx="33" cy="31" rx="23" ry="24" fill="var(--hair,#776052)"/><path d="M20 15q10-8 23-2m-27 9q15-6 30-1" fill="none" stroke="#fff" opacity=".12" stroke-width="3" stroke-linecap="round"/></g>
      </g>
      <g class="avatar-desk-hands"><g class="avatar-desk-arm far"><path d="M18 61Q4 57 6 40" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round"/><ellipse cx="6" cy="36" rx="4.5" ry="4" fill="#f3c9a8"/></g><g class="avatar-desk-arm near"><path d="M48 61q14-4 12-21" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round"/><ellipse cx="60" cy="36" rx="4.5" ry="4" fill="#f3c9a8"/></g></g>
      <g class="avatar-item avatar-book"><path d="m12 65 21 4 21-4v20l-21 4-21-4z" fill="#e8edda" stroke="#9ab18d" stroke-width="1.6"/><path d="M33 69v20m-15-17 10 2m-10 4 10 2m10-6 10-2m-10 8 10-2" stroke="#b5c4a1"/><path class="avatar-page" d="m33 69 20-4v20l-20 4z" fill="#fff9e9" stroke="#c3c9ab"/></g>
      <g class="avatar-item avatar-note"><rect x="23" y="67" width="25" height="19" rx="3" fill="#ffedb1" stroke="#d8c48f"/><path d="M27 72h16m-16 5h12m-12 5h9" stroke="#b8a478"/><path d="m50 64-10 18" stroke="#8195af" stroke-width="3" stroke-linecap="round"/></g>
      <g class="avatar-item avatar-write"><rect x="16" y="67" width="36" height="20" rx="3" fill="#fff7e9" stroke="#d7b9a5"/><path d="M23 67v20m5-13h16m-16 5h12" stroke="#d4c2ac"/><path class="avatar-pencil" d="m49 64-10 18" stroke="#d6aa6f" stroke-width="4" stroke-linecap="round"/></g>
      <g class="avatar-item avatar-mug"><path d="M35 48h13v13q-6 5-13 0z" fill="#abd0c3" stroke="#7eafa0"/><path d="M48 50q11 0 1 9" fill="none" stroke="#7eafa0" stroke-width="3"/><path d="M39 42q-2-3 1-5m4 5q-2-3 1-5" stroke="#d0bfb0" fill="none" stroke-linecap="round"/></g>
      <g class="avatar-item avatar-think"><path d="M51 6q-10 0-9 9 0 6 6 9v4h7v-4q7-4 6-10-1-8-10-8z" fill="#ffed9b" stroke="#dfc67c" stroke-width="1.5"/><path d="M48 31h7m-5-17 2 10 3-10" stroke="#c5a76b" fill="none"/></g>
      <g class="avatar-item avatar-watch"><circle cx="17" cy="67" r="6.2" fill="#fff6df" stroke="#7eaaa3" stroke-width="2.5"/><path d="M17 63v5l3 1" fill="none" stroke="#78958e"/></g>
      <g class="avatar-item avatar-letter"><rect x="17" y="66" width="34" height="23" rx="3" fill="#fff8e5" stroke="#c8b38e" stroke-width="1.5"/><path d="m18 67 16 11 16-11" fill="none" stroke="#c8b38e"/><path d="M32 76q2-4 4 0-1 3-2 4-2-2-2-4" fill="#dfa4a2"/></g>
      <g class="avatar-item avatar-doze" fill="#aaa9c8" font-family="sans-serif" font-weight="700"><text x="52" y="22" font-size="11">z</text><text x="57" y="10" font-size="8">z</text></g>
      <g class="avatar-item avatar-headphones"><path d="M8 34V27q0-24 25-24t25 24v7" fill="none" stroke="#b1a2cd" stroke-width="5"/><rect x="5" y="27" width="8" height="17" rx="4" fill="#c6b5df"/><rect x="53" y="27" width="8" height="17" rx="4" fill="#c6b5df"/></g>
      <g class="avatar-item avatar-celebration" fill="#edd58c"><path d="m8 7 2 5 5 2-5 2-2 5-2-5-5-2 5-2zM57 4l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/><circle cx="60" cy="28" r="2" fill="#d8b3c8"/><circle cx="5" cy="30" r="2" fill="#a9c9b1"/></g>
      <g class="avatar-item avatar-clap"><path d="m29 60 4-5 4 5m-9 2-5-2m15 2 5-2" fill="none" stroke="#e0bd75" stroke-width="2" stroke-linecap="round"/></g>
      <g class="avatar-item avatar-thumbsup"><path d="M43 68v-7q0-6 4-6l2 7h7q4 0 2 6l-2 7H44z" fill="#f5cfab" stroke="#ddb28c" stroke-width="1.3"/></g>
    </svg>`;
    station.append(person);return station;
  }
  // Ambient rest uses one clock for all seats and never fabricates office events or agent status.
  const workClips=['typing','write','think'];
  const idleClips=['sip','stretch','headphones','watch','relax','doze'];
  const seatSeed=node=>{let seed=0;for(const c of node.dataset.replayKey||node.dataset.role||node.dataset.seat||'')seed=(Math.imul(seed,31)+c.charCodeAt(0))>>>0;return seed;};
  class Scene {
    constructor(root,wires,status,scale){
      Object.assign(this,{root,wires,status,scale,epoch:0,queue:[],running:false,animations:new Set(),motion:true,list:false,seen:new Set(),replaying:false,variants:new Map(),active:false,idleTimer:null,idleSeats:new Map()});
      document.body.classList.toggle('office-hidden',document.hidden);this.media=window.matchMedia('(prefers-reduced-motion: reduce)');this.media.addEventListener('change',()=>{this.stop();this.startIdle();});
      document.addEventListener('visibilitychange',()=>{document.body.classList.toggle('office-hidden',document.hidden);if(document.hidden){if(this.replaying){this.pauseReplay();this.onReplayVisibility?.();}else this.stop();}else this.startIdle();});
    }
    reset(){this.active=false;this.stop();this.seen.clear();this.variants.clear();}
    stop(){this.stopIdle();this.epoch++;this.queue=[];this.running=false;for(const a of this.animations)a.cancel();this.animations.clear();this.wires.replaceChildren();this.root.classList.remove('replay-paused');for(const n of this.root.querySelectorAll('.is-live,.has-motion,.is-walking,.is-standing'))n.classList.remove('is-live','has-motion','is-walking','is-standing');for(const n of this.root.querySelectorAll('.office-action-bubble'))n.remove();for(const n of this.root.querySelectorAll('.office-person'))clearAction(n);for(const n of this.root.querySelectorAll('.office-desk'))if(n.dataset.busy==='true')n.querySelector('.office-person').dataset.facing='desk';this.status.textContent=this.replaying?'历史回放已暂停。':'休息动作是场景装饰；工作与消息动作来自实际交互。';}
    enabled(){return this.motion&&!this.list&&!this.media.matches&&!document.hidden;}
    setActive(on){this.active=on;if(on)this.startIdle();else this.stop();}
    stopIdle(){clearInterval(this.idleTimer);this.idleTimer=null;for(const {person} of this.idleSeats.values())if(person.dataset.idle)clearAction(person);this.idleSeats.clear();}
    startIdle(){
      if(this.idleTimer||!this.active||!this.enabled()||this.replaying)return;
      if(!this.root.querySelectorAll('.office-desk').length)return;
      this.idleTick();this.idleTimer=setInterval(()=>this.idleTick(),80);
    }
    idleTick(){
      if(!this.active||!this.enabled()||this.replaying){this.stopIdle();return;}
      const now=Date.now(),nodes=[...this.root.querySelectorAll('.office-desk')],current=new Set(nodes);
      for(const [node,row] of this.idleSeats)if(!current.has(node)){if(row.person.dataset.idle)clearAction(row.person);this.idleSeats.delete(node);}
      for(const node of nodes){
        const person=node.querySelector('.office-person');if(!person)continue;
        if(node.classList.contains('is-live')){
          if(person.dataset.idle)clearAction(person);
          this.idleSeats.delete(node);continue;
        }
        const working=node.dataset.busy==='true',clips=working?workClips:idleClips;
        let row=this.idleSeats.get(node);
        if(row&&row.working!==working){clearAction(person);this.idleSeats.delete(node);row=null;}
        if(!row){const seed=seatSeed(node),used=new Set([...this.idleSeats.values()].map(r=>r.index));let index=seed%clips.length;for(let i=0;i<clips.length&&used.has(index);i++)index=(index+1)%clips.length;row={person,seed,index,working,start:now+seed%1300,duration:4800+seed%1800};this.idleSeats.set(node,row);clearAction(person);}
        person.dataset.facing=working?'desk':'down';person.dataset.posture='seated';person.dataset.idle='true';
        if(now<row.start)continue;
        const progress=(now-row.start)/row.duration;
        if(progress>=1){clearAction(person);person.dataset.idle='true';row.index=(row.index+1)%clips.length;row.start=now+1100+(row.seed+row.index*337)%1500;continue;}
        const clip=clips[row.index];person.dataset.pose=clip;drawAction(person,sampleAction(clip,progress));
      }
    }
    setMotion(on){this.motion=on;this.root.classList.toggle('motion-off',!on);if(!on)this.stop();else this.startIdle();}
    beginReplay(){this.stop();this.replaying=true;this.root.classList.add('is-replaying');this.status.textContent='历史回放 · 已就绪（未播放）';}
    endReplay(){this.stop();this.replaying=false;this.root.classList.remove('is-replaying');this.startIdle();this.status.textContent='休息动作是场景装饰；工作与消息动作来自实际交互。';}
    pauseReplay(){for(const a of this.animations)a.pause();this.root.classList.add('replay-paused');}
    resumeReplay(){for(const a of this.animations)a.play();this.root.classList.remove('replay-paused');}
    setReplayRate(rate){for(const a of this.animations)a.updatePlaybackRate(rate);}
    replayEvent(e,options){return this.play({...e,replay:true,...options},this.epoch);}
    present(events,{demo=false}={}){
      if(this.replaying||!this.enabled())return;
      for(const e of events){if(!demo){if(this.seen.has(e.seq))continue;this.seen.add(e.seq);if(this.seen.size>500)this.seen.delete(this.seen.values().next().value);if(!Number.isFinite(e.ts)||Date.now()-e.ts>15000||e.ts>Date.now()+1000)continue;}if(!labels[e.kind])continue;this.queue.push({...e,demo});}
      this.queue=this.queue.slice(-8);if(!this.running)void this.drain(this.epoch);
    }
    async drain(epoch){this.running=true;try{while(this.queue.length&&epoch===this.epoch&&this.enabled()&&!this.replaying)await this.play(this.queue.shift(),epoch);}finally{if(epoch===this.epoch){this.running=false;this.status.textContent='休息动作是场景装饰；工作与消息动作来自实际交互。';}}}
    async play(e,epoch){
      if(!e.demo&&!e.replay&&Date.now()-e.ts>15000)return 'cancelled';
      const nodes=[...this.root.querySelectorAll('.office-desk')],body=e.body??{};
      const from=nodes.find(n=>(e.actorKey&&n.dataset.replayKey===e.actorKey)||n.dataset.seat===e.seat_id||n.dataset.role===(body.sender??e.actor?.roleId));
      if(!from){if(e.replay)return this.clock(e);return 'completed';}
      const to=nodes.find(n=>n.dataset.seat===body.recipient||n.dataset.role===body.recipient||(e.recipientKey&&n.dataset.replayKey===e.recipientKey)),person=from.querySelector('.office-person');
      if(!person)return e.replay?this.clock(e):'completed';
      if(person.dataset.idle)clearAction(person);this.idleSeats.delete(from);
      const name=from.querySelector('strong')?.textContent??'角色',label=labels[e.kind]??e.kind;
      this.status.textContent=(e.replay?'历史回放：':e.demo?'动画演示（不发送消息、不启动 agent）：':'刚刚：')+name+' · '+label;
      const bubble=document.createElement('span');bubble.className='office-action-bubble';bubble.textContent=(e.demo?'演示 · ':'')+label;from.append(bubble);from.classList.add('has-motion','is-live');
      const s=this.scale();
      let frames,duration=3200,travel;
      if(this.enabled()&&to&&to!==from&&['message','inform','request','reply'].includes(e.kind)){
        // An occupied chair is intentional contact at rest. Tuck only this chair under its desk
        // before measuring the walking obstacles; every other chair remains solid.
        from.classList.add('is-standing');person.dataset.posture='standing';
        const nav=window.MindPondOfficeNavigation,room=this.root.getBoundingClientRect();
        const box=n=>{const r=n.getBoundingClientRect();return {left:(r.left-room.left)/s,top:(r.top-room.top)/s,right:(r.left+r.width-room.left)/s,bottom:(r.top+r.height-room.top)/s};};
        const a=box(person),target=box(to.querySelector('.office-person')),origin={x:(a.left+a.right)/2,y:(a.top+a.bottom)/2},end={x:(target.left+target.right)/2,y:(target.top+target.bottom)/2};
        const halfWidth=(a.right-a.left)/2,halfHeight=(a.bottom-a.top)/2;
        const obstacles=[...this.root.querySelectorAll('.office-table,.office-chair,.office-monitor,.office-task-light,.office-room-door,.office-room-lounge'),...nodes.filter(n=>n!==from).map(n=>n.querySelector('.office-person'))].map(box);
        const options={bounds:{left:12,top:28,right:room.width/s-12,bottom:room.height/s-12},obstacles,halfWidth,halfHeight,clearance:12};
        const dx=halfWidth+(target.right-target.left)/2+26,dy=halfHeight+(target.bottom-target.top)/2+26;
        const chair=box(to.querySelector('.office-chair')),front=Math.max(target.bottom,chair.bottom)+halfHeight+26;
        const goals=[{x:end.x-dx,y:end.y},{x:end.x+dx,y:end.y},{x:end.x,y:end.y-dy},{x:end.x,y:front}];
        const length=path=>path.reduce((n,p,i)=>n+(i?Math.hypot(p.x-path[i-1].x,p.y-path[i-1].y):0),0);
        let route;
        for(const goal of goals.sort((a,b)=>Math.hypot(a.x-origin.x,a.y-origin.y)-Math.hypot(b.x-origin.x,b.y-origin.y))){route=nav.planRoute(origin,goal,options);if(route)break;}
        if(!route){from.classList.remove('is-standing');person.dataset.posture='seated';bubble.textContent=(e.demo?'演示 · ':'')+'通道不足，原地等待';this.status.textContent=bubble.textContent;frames=[{transform:'none'},{transform:'none'}];}
        else{
          const pathFrames=nav.framesForRoute(route,origin);
          frames=[{transform:'translate(0px,-125px)',offset:0},...pathFrames.map(f=>({...f,offset:.08+f.offset*.84})),{transform:'translate(0px,-125px)',offset:.96},{transform:'translate(0px,-125px)',offset:1}];
          const destination=route.at(-1),lookX=end.x-destination.x,lookY=end.y-destination.y;
          travel={arrival:frames[route.length].offset,departure:frames[route.length+1].offset,look:Math.abs(lookX)>Math.abs(lookY)?(lookX>0?'right':'left'):(lookY>0?'down':'up')};
          duration=Math.max(3600,Math.min(16000,length(route)/100*2000+1400));
          const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',route.map((p,i)=>(i?'L':'M')+p.x+' '+p.y).join(' '));this.wires.append(path);
        }
      }else frames=[{transform:'none'},{transform:'none'}];
      duration=e.durationMs??duration;
      if(!this.enabled()){frames=[{},{}];from.classList.remove('is-walking');this.wires.replaceChildren();}
      const state=stateFor(e.kind),choices=e.demo&&Object.hasOwn(actions,e.demoClip)?[actions[e.demoClip]]:catalog[state],key=(e.actorKey??from.dataset.role??from.dataset.seat)+':'+state;
      const seed=e.replay?(e.seq??0)%choices.length:this.variants.get(key)??0;this.variants.set(key,(seed+1)%choices.length);
      const animation=person.animate(frames,{duration,easing:'linear'});animation.updatePlaybackRate(e.rate??1);this.animations.add(animation);
      let last='';const tick=()=>{
        const elapsed=Number(animation.currentTime??0),progress=Math.min(1,elapsed/duration),segments=Math.max(1,Math.floor(duration/2000)),segmentDuration=duration/segments,phase=this.enabled()?Math.min(segments-1,Math.floor(elapsed/segmentDuration)):0,localProgress=this.enabled()?Math.min(1,(elapsed-phase*segmentDuration)/segmentDuration):progress,pose=choices[(seed+phase)%choices.length];
        let action=pose.label+' · '+pose.stages[localProgress<.15?0:localProgress>.88?2:1];
        drawAction(person,sampleAction(pose.id,this.enabled()?localProgress:.5));
        if(!travel)person.dataset.facing=['working','reading'].includes(state)?'desk':'down';
        if(travel){
          const walking=progress>.08&&progress<travel.arrival||progress>travel.departure&&progress<.92;
          from.classList.toggle('is-walking',walking);person.dataset.posture=progress>=.96?'seated':'standing';
          from.classList.toggle('is-standing',true);
          const next=frames.findIndex(f=>f.offset>progress),a=frames[Math.max(0,next-1)],b=frames[Math.max(0,next)];
          const point=f=>{const xy=f.transform.match(/translate\(([-.0-9]+)px,([-.0-9]+)px\)/);return {x:Number(xy?.[1]??0),y:Number(xy?.[2]??0)};};
          const pa=point(a),pb=point(b),dx=pb.x-pa.x,dy=pb.y-pa.y;
          if(walking)person.dataset.facing=Math.abs(dx)>Math.abs(dy)?(dx>0?'right':'left'):(dy>0?'down':'up');
          else person.dataset.facing=progress>=.96?'desk':progress>=travel.arrival&&progress<=travel.departure?travel.look:'up';
          action=progress<=.08?'起身离开座位':progress<travel.arrival?'走向同事':progress<=travel.departure?'停下交流':progress<.92?'返回工位':progress<.96?'回到座位':'落座';
        }
        const stamp=action+':'+phase;if(last!==stamp){last=stamp;person.dataset.pose=pose.id;bubble.textContent=(e.replay?'回放 · ':e.demo?'演示 · ':'')+label+' · '+action;}
        e.onProgress?.(progress);
      };tick();const timer=setInterval(tick,80);
      let result='completed';try{await animation.finished;}catch{result='cancelled';}finally{clearInterval(timer);this.animations.delete(animation);animation.cancel();bubble.remove();if(epoch===this.epoch){clearAction(person);from.classList.remove('has-motion','is-live','is-walking','is-standing');this.wires.replaceChildren();if(from.dataset.busy==='true')person.dataset.facing='desk';this.startIdle();}}
      return result;
    }
    async clock(e){this.status.textContent='历史回放 · '+(labels[e.kind]??e.kind);const animation=this.root.animate([{},{}],{duration:e.durationMs??2000});animation.updatePlaybackRate(e.rate??1);this.animations.add(animation);const timer=setInterval(()=>e.onProgress?.(Math.min(1,Number(animation.currentTime??0)/(e.durationMs??2000))),120);let result='completed';try{await animation.finished;}catch{result='cancelled';}finally{clearInterval(timer);this.animations.delete(animation);animation.cancel();}return result;}
    demo(selection='working'){
      this.stop();if(this.replaying)return;
      if(!this.enabled()){this.status.textContent='动态效果已关闭；可使用列表查看全部信息。';return;}
      const nodes=[...this.root.querySelectorAll('.office-desk')];if(!nodes.length){this.status.textContent='邀请角色加入后，可以预览人物动作。';return;}
      const family=Object.keys(catalog).find(k=>catalog[k].some(a=>a.id===selection)),state=family??selection,clip=family?selection:undefined;
      const from=nodes[0],to=nodes[1]??from,kind={reading:'material_read',working:'work_pose',waiting:'wait_pose',resting:'rest_pose',communicating:'message',celebrating:'celebrate_pose'}[state]??'work_pose';
      this.present(Array.from({length:clip?1:3},()=>({kind,seat_id:from.dataset.seat,body:{recipient:to.dataset.role||to.dataset.seat},...(clip?{demoClip:clip}:{})})),{demo:true});
    }

  }
  window.MindPondOfficeScene={Scene,props,catalog,stateFor,sampleAction,idleClips};
})();
