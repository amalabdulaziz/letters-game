import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  getDatabase, ref, get, set, update, onValue, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

let app, auth, db, uid="";
let roomCode="", roomRef=null, unsubscribe=null;
let onlineTimerId=null, finishedRoom="";
let joining=false, creating=false;

window.onlineSlot="";
window.onlineNames={p1:"اللاعب 1",p2:"اللاعب 2"};

const configured=()=>firebaseConfig.apiKey && !firebaseConfig.apiKey.includes("PUT_");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function refreshGameGlobals(){
  if(!window.state)window.state={};
  if(!window.playerData)throw new Error("تعذر تحميل بيانات اللاعب");
}

async function ensureFirebase(){
  refreshGameGlobals();
  if(!configured())throw new Error("لم يتم وضع بيانات Firebase في firebase-config.js");
  if(!app){
    app=initializeApp(firebaseConfig);
    auth=getAuth(app);
    db=getDatabase(app);
  }
  if(!auth.currentUser){
    const result=await signInAnonymously(auth);
    uid=result.user.uid;
  }else uid=auth.currentUser.uid;
}

function setStatus(text){
  const box=document.getElementById("onlineStatusBox");
  const el=document.getElementById("onlineStatusText");
  box.hidden=false;
  el.textContent=text;
}
function showRoomCode(code){
  document.getElementById("roomCodeView").hidden=false;
  document.getElementById("roomCodeText").textContent=code;
}
function showPlayers(room){
  const box=document.getElementById("onlinePlayers");
  box.innerHTML="";
  [["المضيف",room.host],["الضيف",room.guest]].forEach(([label,p])=>{
    const row=document.createElement("div");
    row.className="onlinePlayerRow";
    row.textContent=p?`${label}: ${p.name} ✅`:`${label}: بانتظار اللاعب...`;
    box.appendChild(row);
  });
}
function randomCode(){return String(Math.floor(100000+Math.random()*900000))}
function initialGame(hostName,guestName){
  return {
    mode:"online",diff:"normal",count:2,time:15,turn:"p1",status:"picking",
    round:1,golden:window.rnd(window.letters),used:{},scores:{p1:0,p2:0,p3:0},
    lives:{p1:3,p2:3,p3:0},currentL:"",cat:"",lastCat:"",timer:15,
    msg:`${hostName||"اللاعب 1"} اختر حرفاً`,deadline:0,winner:"",
    startedAt:Date.now(),hostName:hostName||"اللاعب 1",guestName:guestName||"اللاعب 2"
  };
}

function detachRoom(){
  if(unsubscribe){unsubscribe();unsubscribe=null}
}

async function attachRoom(code){
  detachRoom();
  roomCode=code;
  roomRef=ref(db,"rooms/"+code);
  unsubscribe=onValue(roomRef,snap=>{
    const room=snap.val();
    if(!room){
      setStatus("الغرفة غير موجودة. تأكد من الكود أو أنشئ غرفة جديدة.");
      return;
    }
    showRoomCode(code);
    showPlayers(room);
    window.onlineNames={
      p1:room.host?.name||room.game?.hostName||"اللاعب 1",
      p2:room.guest?.name||room.game?.guestName||"اللاعب 2"
    };

    if(!room.guest){
      setStatus("بانتظار دخول اللاعب الثاني...");
      return;
    }

    if(!room.game){
      setStatus("تم اتصال اللاعبين، جاري بدء المباراة...");
      return;
    }

    setStatus("تم اتصال اللاعبين ✅");
    document.getElementById("onlineBadge").hidden=false;
    document.getElementById("onlineLobbyModal").classList.remove("show");

    Object.keys(window.state).forEach(k=>delete window.state[k]);
    Object.assign(window.state,room.game,{mode:"online",count:2});
    document.getElementById("p3Area").style.display="none";
    if(!document.getElementById("letters").children.length)window.buildLetters();
    window.show("game");
    window.render();
    window.onlineStartTimer();
    if(room.game.status==="ended")finishOnline(room.game.winner);
  },err=>setStatus("❌ تعذر متابعة الغرفة: "+err.message));
}

window.openOnlineLobby=async function(){
  document.getElementById("onlineLobbyModal").classList.add("show");
  document.getElementById("onlineStatusBox").hidden=true;
  document.getElementById("roomCodeView").hidden=true;
  document.getElementById("onlinePlayers").innerHTML="";
  try{await ensureFirebase();setStatus("جاهز لإنشاء غرفة أو الدخول.")}
  catch(e){setStatus("⚠️ "+e.message)}
};
window.closeOnlineLobby=function(){document.getElementById("onlineLobbyModal").classList.remove("show")};

window.createOnlineRoom=async function(){
  if(creating)return;
  creating=true;
  const btn=document.getElementById("createRoomBtn");
  btn.disabled=true;
  try{
    await ensureFirebase();
    setStatus("جاري إنشاء الغرفة...");
    let code="";
    for(let i=0;i<12;i++){
      const candidate=randomCode();
      const candidateRef=ref(db,"rooms/"+candidate);
      const result=await runTransaction(candidateRef,current=>{
        if(current!==null)return;
        return {
          createdAt:Date.now(),updatedAt:Date.now(),status:"waiting",
          host:{uid,name:window.playerData.name||"اللاعب 1",joinedAt:Date.now()}
        };
      });
      if(result.committed){code=candidate;break}
    }
    if(!code)throw new Error("تعذر إنشاء كود غرفة، حاول مرة أخرى");
    window.onlineSlot="p1";
    showRoomCode(code);
    await attachRoom(code);
  }catch(e){setStatus("❌ "+e.message)}
  finally{creating=false;btn.disabled=false}
};

window.joinOnlineRoom=async function(){
  if(joining)return;
  joining=true;
  const btn=document.getElementById("joinRoomBtn");
  btn.disabled=true;
  try{
    await ensureFirebase();
    const code=document.getElementById("roomCodeInput").value.replace(/\D/g,"").slice(0,6);
    if(code.length!==6)throw new Error("اكتب كود الغرفة المكوّن من 6 أرقام");
    setStatus("جاري الدخول إلى الغرفة...");
    const r=ref(db,"rooms/"+code);

    const result=await runTransaction(r,room=>{
      if(!room)return;
      if(room.status==="ended")return;

      // إعادة اتصال نفس الجهاز مسموحة.
      if(room.host?.uid===uid){
        room.host.name=window.playerData.name||room.host.name||"اللاعب 1";
        room.updatedAt=Date.now();
        return room;
      }
      if(room.guest && room.guest.uid!==uid)return;

      room.guest={uid,name:window.playerData.name||"اللاعب 2",joinedAt:Date.now()};
      room.status="playing";
      room.updatedAt=Date.now();
      if(!room.game){
        room.game=initialGame(room.host?.name,room.guest.name);
      }
      return room;
    });

    if(!result.committed){
      const latest=(await get(r)).val();
      if(!latest)throw new Error("الغرفة غير موجودة");
      if(latest.status==="ended")throw new Error("انتهت هذه الغرفة، أنشئ غرفة جديدة");
      throw new Error("الغرفة ممتلئة بلاعبين");
    }

    const room=result.snapshot.val();
    window.onlineSlot=room.host?.uid===uid?"p1":"p2";
    showRoomCode(code);
    await attachRoom(code);
  }catch(e){setStatus("❌ "+e.message)}
  finally{joining=false;btn.disabled=false}
};

window.copyOnlineRoomCode=async function(){
  try{await navigator.clipboard.writeText(roomCode);window.toast("تم نسخ الكود ✅")}
  catch{window.toast("الكود: "+roomCode)}
};

function myTurn(g){return g.turn===window.onlineSlot}
function advance(g){
  g.turn=g.turn==="p1"?"p2":"p1";
  g.status="picking";g.currentL="";g.cat="";
  g.round=(g.round||1)+1;
  g.time=g.round%7===0?6:15;
  g.timer=g.time;g.deadline=0;
  g.msg=(window.onlineNames[g.turn]||g.turn)+" اختر حرفاً";
  if(window.letters.every(l=>g.used&&g.used[l])){
    g.used={};g.golden=window.rnd(window.letters);
  }
}
function setEndedIfNeeded(g){
  const alive=["p1","p2"].filter(p=>(g.lives[p]||0)>0);
  if(alive.length<=1){
    g.status="ended";
    g.winner=alive[0]||((g.scores.p1||0)>=(g.scores.p2||0)?"p1":"p2");
    g.deadline=0;
    return true;
  }
  return false;
}

window.onlinePick=async function(letter){
  if(!roomRef)return;
  const result=await runTransaction(ref(db,"rooms/"+roomCode+"/game"),g=>{
    if(!g||g.status!=="picking"||!myTurn(g)||g.used?.[letter])return;
    g.used=g.used||{};
    g.used[letter]=true;
    g.currentL=letter;
    g.cat=window.chooseCategoryForLetter(letter);
    g.lastCat=g.cat;
    g.status="answering";
    g.timer=g.time||15;
    g.deadline=Date.now()+g.timer*1000;
    g.msg=(window.onlineNames[g.turn]||g.turn)+" | "+g.cat+" بحرف ("+letter+")";
    return g;
  });
  if(!result.committed)window.toast("ليس دورك الآن");
};

window.onlineSubmitAnswer=async function(){
  const input=document.getElementById("answer");
  const value=input.value.trim();
  if(!value||!roomRef)return;
  const localGame=window.state;
  const correct=window.getWords(localGame.cat,localGame.currentL)
    .some(w=>window.norm(w)===window.norm(value));
  let committedCorrect=false,golden=false;

  const result=await runTransaction(ref(db,"rooms/"+roomCode+"/game"),g=>{
    if(!g||g.status!=="answering"||!myTurn(g))return;
    if(correct){
      const pts=g.currentL===g.golden?2:1;
      g.scores[g.turn]=(g.scores[g.turn]||0)+pts;
      committedCorrect=true;
      golden=g.currentL===g.golden;
      g.msg="✅ إجابة صحيحة: "+value;
    }else{
      g.lives[g.turn]=Math.max(0,(g.lives[g.turn]||0)-1);
      g.msg="❌ إجابة غير صحيحة";
    }
    if(!setEndedIfNeeded(g))advance(g);
    return g;
  });

  input.value="";
  if(!result.committed){window.toast("انتهى الدور أو ليست هذه جولتك");return}
  if(committedCorrect){
    window.playerData.correctAnswers=(window.playerData.correctAnswers||0)+1;
    window.addXP(10,"إجابة صحيحة");
    if(golden){
      window.playerData.golden++;
      window.playerData.coins+=20;
      window.addXP(20,"حرف ذهبي");
    }
    window.savePlayer();
    window.checkAchievements();
  }
};

window.onlineStartTimer=function(){
  clearInterval(onlineTimerId);
  if(window.state.status!=="answering"||!window.state.deadline)return;
  const tick=()=>{
    const left=Math.max(0,Math.ceil((window.state.deadline-Date.now())/1000));
    window.state.timer=left;
    window.render();
    if(left<=0){
      clearInterval(onlineTimerId);
      if(myTurn(window.state))onlineTimeout();
    }
  };
  tick();
  onlineTimerId=setInterval(tick,500);
};

async function onlineTimeout(){
  if(!roomRef)return;
  await runTransaction(ref(db,"rooms/"+roomCode+"/game"),g=>{
    if(!g||g.status!=="answering"||!myTurn(g)||Date.now()<g.deadline-300)return;
    g.lives[g.turn]=Math.max(0,(g.lives[g.turn]||0)-1);
    g.msg="⏰ انتهى الوقت!";
    if(!setEndedIfNeeded(g))advance(g);
    return g;
  });
}

function finishOnline(winner){
  if(finishedRoom===roomCode)return;
  finishedRoom=roomCode;
  clearInterval(onlineTimerId);
  const won=winner===window.onlineSlot;
  window.playerData.games++;
  window.playerData.highScore=Math.max(
    window.playerData.highScore,
    window.state.scores[window.onlineSlot]||0
  );
  if(won){
    window.playerData.wins++;
    window.playerData.coins+=50;
    window.addXP(100,"فوز أونلاين");
  }
  window.savePlayer();
  window.checkAchievements();
  window.show("end");
  document.getElementById("winnerText").textContent="👑 الفائز: "+(window.onlineNames[winner]||winner);
  document.getElementById("finalScore").textContent=
    `${window.onlineNames.p1}: ${window.state.scores.p1||0} | ${window.onlineNames.p2}: ${window.state.scores.p2||0}`;
  window.fireworks();
}

window.leaveOnlineRoom=async function(){
  clearInterval(onlineTimerId);
  document.getElementById("onlineBadge").hidden=true;
  detachRoom();
  roomRef=null;
  roomCode="";
  window.onlineSlot="";
  finishedRoom="";
};
