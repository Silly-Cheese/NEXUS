import {
  collection, addDoc, updateDoc, deleteDoc, setDoc, doc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const EXPENSE_CATEGORIES = [
  "Groceries","Dining","Transportation","Books","Electronics","Household",
  "Personal Care","Education","Entertainment","Subscriptions","Medical","Gifts","Other"
];
const INCOME_CATEGORIES = [
  "Paycheck","Side Income","Gift","Refund","Reimbursement","Scholarship","Other Income"
];
const CADENCES = [
  ["weekly","Weekly"],["biweekly","Every 2 weeks"],["semimonthly","Twice monthly"],
  ["monthly","Monthly"],["quarterly","Quarterly"],["annual","Annually"],["one-time","One time"]
];

const BUDGET = { initialized:false };

function N(){ return window.NEXUS; }
function S(){ return N().state; }
function esc(v){ return N().escapeHtml(v); }
function money(v){ return N().money(v); }
function todayISO(){ return N().todayISO(); }
function monthKey(v){ return N().monthKey(v); }
function norm(v){ return N().normalize(v); }

function currentMonthKey(){ return monthKey(new Date()); }
function parseDate(iso){ return new Date(String(iso || todayISO()) + "T12:00:00"); }
function isoDate(date){ return date.getFullYear()+"-"+String(date.getMonth()+1).padStart(2,"0")+"-"+String(date.getDate()).padStart(2,"0"); }
function monthStart(){
  const d=new Date(); return new Date(d.getFullYear(),d.getMonth(),1,12);
}
function monthEnd(){
  const d=new Date(); return new Date(d.getFullYear(),d.getMonth()+1,0,12);
}
function daysInCurrentMonth(){ return monthEnd().getDate(); }
function elapsedDays(){ return Math.max(1,new Date().getDate()); }
function remainingDays(){ return Math.max(1,daysInCurrentMonth()-new Date().getDate()+1); }

function option(value,label,selected){
  return "<option value='"+esc(value)+"' "+(String(value)===String(selected)?"selected":"")+">"+esc(label == null ? value : label)+"</option>";
}
function expenseCategoryOptions(selected){
  return EXPENSE_CATEGORIES.map(function(c){return option(c,c,selected);}).join("");
}
function incomeCategoryOptions(selected){
  return INCOME_CATEGORIES.map(function(c){return option(c,c,selected);}).join("");
}
function cadenceOptions(selected){
  return CADENCES.map(function(entry){return option(entry[0],entry[1],selected);}).join("");
}
function badge(text,type){ return "<span class='badge "+(type||"")+"'>"+esc(text)+"</span>"; }

function monthlyEquivalent(amount,cadence){
  amount=Number(amount||0);
  if(cadence==="weekly") return amount*52/12;
  if(cadence==="biweekly") return amount*26/12;
  if(cadence==="semimonthly") return amount*2;
  if(cadence==="quarterly") return amount/3;
  if(cadence==="annual") return amount/12;
  if(cadence==="one-time") return amount;
  return amount;
}

function payPeriodLengthDays(cadence){
  if(cadence==="weekly") return 7;
  if(cadence==="biweekly") return 14;
  if(cadence==="semimonthly") return 15;
  if(cadence==="monthly") return 30;
  return 14;
}

function periodEndFromStart(start,cadence){
  const d=parseDate(start||todayISO());
  d.setDate(d.getDate()+payPeriodLengthDays(cadence)-1);
  return isoDate(d);
}

function shiftPeriodDate(iso,cadence){
  const d=parseDate(iso||todayISO());
  d.setDate(d.getDate()+payPeriodLengthDays(cadence));
  return isoDate(d);
}

function sourcePeriodLogs(source){
  if(!source || !source.id)return [];
  const start=source.periodStart||"0000-01-01";
  const end=source.periodEnd||"9999-12-31";
  return (S().data.workHours||[]).filter(function(log){
    return log.sourceId===source.id && String(log.date||"")>=start && String(log.date||"")<=end;
  }).sort(function(a,b){return String(b.date||"").localeCompare(String(a.date||""));});
}

function hourlyPeriodStats(source){
  const logs=sourcePeriodLogs(source);
  const hourlyRate=Math.max(0,Number(source&&source.hourlyRate||0));
  const overtimeMultiplier=Math.max(1,Number(source&&source.overtimeMultiplier||1.5));
  const takeHomePercent=Math.max(0,Math.min(100,Number(source&&source.takeHomePercent == null ? 100 : source.takeHomePercent)));
  const regularHours=logs.reduce(function(sum,log){return sum+Number(log.hours||0);},0);
  const overtimeHours=logs.reduce(function(sum,log){return sum+Number(log.overtimeHours||0);},0);
  const gross=regularHours*hourlyRate + overtimeHours*hourlyRate*overtimeMultiplier;
  const estimatedNet=gross*(takeHomePercent/100);
  return {
    logs:logs,regularHours:regularHours,overtimeHours:overtimeHours,totalHours:regularHours+overtimeHours,
    hourlyRate:hourlyRate,overtimeMultiplier:overtimeMultiplier,takeHomePercent:takeHomePercent,
    gross:gross,estimatedNet:estimatedNet
  };
}

function incomeSourcePaymentEstimate(source){
  if(source && source.payType==="hourly") return hourlyPeriodStats(source).estimatedNet;
  return Number(source&&source.amount||0);
}

function plannedMonthlyAmount(item,dateField){
  if(!item || item.active===false) return 0;
  const perPayment=item.payType==="hourly" ? incomeSourcePaymentEstimate(item) : Number(item.amount||0);
  if(item.cadence==="one-time"){
    const date=item[dateField];
    return date && monthKey(date)===currentMonthKey() ? perPayment : 0;
  }
  return monthlyEquivalent(perPayment,item.cadence);
}

function advanceDate(iso,cadence){
  const d=parseDate(iso || todayISO());
  if(cadence==="weekly") d.setDate(d.getDate()+7);
  else if(cadence==="biweekly") d.setDate(d.getDate()+14);
  else if(cadence==="semimonthly") d.setDate(d.getDate()+15);
  else if(cadence==="quarterly") d.setMonth(d.getMonth()+3);
  else if(cadence==="annual") d.setFullYear(d.getFullYear()+1);
  else d.setMonth(d.getMonth()+1);
  return isoDate(d);
}

function nextFutureDate(iso,cadence,reference){
  if(cadence==="one-time") return iso;
  let next=String(iso||todayISO());
  const ref=parseDate(reference||todayISO());
  let guard=0;
  while(parseDate(next) <= ref && guard<100){
    next=advanceDate(next,cadence);
    guard++;
  }
  return next;
}

function advanceRecordedOccurrence(scheduledDate,cadence,recordDate){
  if(cadence==="one-time") return scheduledDate;
  let next=advanceDate(scheduledDate||recordDate||todayISO(),cadence);
  const ref=parseDate(recordDate||todayISO());
  let guard=0;
  while(parseDate(next) <= ref && guard<100){
    next=advanceDate(next,cadence);
    guard++;
  }
  return next;
}

function datesDueBetween(item,start,end,dateField){
  if(!item || item.active===false) return [];
  let due=String(item[dateField] || "");
  if(!due) return [];
  const cadence=item.cadence || "monthly";
  const out=[];
  let d=parseDate(due);
  const from=start instanceof Date?start:parseDate(start);
  const to=end instanceof Date?end:parseDate(end);
  let guard=0;

  if(cadence!=="one-time"){
    while(d < from && guard<120){
      due=advanceDate(due,cadence);
      d=parseDate(due);
      guard++;
    }
  }
  while(d <= to && guard<180){
    if(d >= from) out.push(isoDate(d));
    if(cadence==="one-time") break;
    due=advanceDate(due,cadence);
    d=parseDate(due);
    guard++;
  }
  return out;
}

function actualIncomeForMonth(key){
  return S().data.transactions.filter(function(t){
    return t.type==="income" && monthKey(t.date)===key;
  });
}
function actualExpensesForMonth(key){
  return S().data.transactions.filter(function(t){
    return (t.type||"expense")==="expense" && monthKey(t.date)===key;
  });
}
function sumAmounts(rows){ return rows.reduce(function(sum,row){return sum+Number(row.amount||0);},0); }

function categorySpending(key){
  const totals={};
  function add(category,amount){
    const name=category||"Other";
    totals[name]=(totals[name]||0)+Number(amount||0);
  }
  S().data.transactions.filter(function(t){
    return (t.type||"expense")==="expense" && monthKey(t.date)===key && !t.sourceReceiptId;
  }).forEach(function(t){add(t.category,t.amount);});

  S().data.receipts.filter(function(r){return monthKey(r.date)===key;}).forEach(function(r){
    const items=r.items||[];
    if(items.length){
      let itemSum=0;
      items.forEach(function(item){
        const amount=Number(item.price||0);
        itemSum+=amount;
        add(item.category,amount);
      });
      const remainder=Number(r.total||0)-itemSum;
      if(remainder>.01)add("Other",remainder);
    }else{
      const linked=S().data.transactions.find(function(t){return t.sourceReceiptId===r.id;});
      add(linked&&linked.category||"Other",r.total);
    }
  });
  return totals;
}

function pastCategoryAverage(category,months){
  const now=new Date();
  let total=0,count=0;
  for(let i=1;i<=months;i++){
    const d=new Date(now.getFullYear(),now.getMonth()-i,1);
    const key=monthKey(d);
    const spend=categorySpending(key)[category]||0;
    total+=spend; count++;
  }
  return count?total/count:0;
}

function actualSavingsForMonth(key){
  return S().data.savingsContributions.filter(function(c){return monthKey(c.date)===key;})
    .reduce(function(sum,c){return sum+Number(c.amount||0);},0);
}

function budgetLimit(record,disposableIncome){
  if(!record || record.active===false) return 0;
  if(record.targetType==="percent") return Math.max(0,disposableIncome*Number(record.value||0)/100);
  return Math.max(0,Number(record.value||0));
}

function snapshot(){
  const key=currentMonthKey();
  const incomeRows=actualIncomeForMonth(key);
  const expenseRows=actualExpensesForMonth(key);
  const actualIncome=sumAmounts(incomeRows);
  const actualExpenses=sumAmounts(expenseRows);

  const allIncomeSources=S().data.incomeSources;
  const activeIncomeSources=allIncomeSources.filter(function(x){return x.active!==false;});
  const expectedIncome=activeIncomeSources.reduce(function(sum,x){return sum+plannedMonthlyAmount(x,"nextDate");},0);
  const budgetedSourceIncome=allIncomeSources.reduce(function(sum,source){
    const planned=source.active===false?0:plannedMonthlyAmount(source,"nextDate");
    const received=incomeRows.filter(function(row){return row.incomeSourceId===source.id;})
      .reduce(function(total,row){return total+Number(row.amount||0);},0);
    return sum+Math.max(planned,received);
  },0);
  const unplannedIncome=incomeRows.filter(function(row){
    return !row.incomeSourceId || !allIncomeSources.some(function(source){return source.id===row.incomeSourceId;});
  }).reduce(function(sum,row){return sum+Number(row.amount||0);},0);
  const budgetIncome=budgetedSourceIncome+unplannedIncome;

  const activeRecurring=S().data.recurringExpenses.filter(function(x){return x.active!==false;});
  const recurringMonthly=activeRecurring.reduce(function(sum,x){return sum+plannedMonthlyAmount(x,"nextDueDate");},0);
  const dueStart=parseDate(todayISO());
  const dueEnd=monthEnd();
  const upcomingRecurring=[];
  activeRecurring.forEach(function(item){
    const firstDue=item.nextDueDate?parseDate(item.nextDueDate):null;
    if(firstDue && firstDue<dueStart){
      upcomingRecurring.push({item:item,date:item.nextDueDate,amount:Number(item.amount||0),overdue:true});
      if(item.cadence!=="one-time"){
        let next=advanceDate(item.nextDueDate,item.cadence);
        let guard=0;
        while(parseDate(next)<=dueEnd && guard<60){
          if(parseDate(next)>=dueStart)upcomingRecurring.push({item:item,date:next,amount:Number(item.amount||0),overdue:false});
          next=advanceDate(next,item.cadence);
          guard++;
        }
      }
    }else{
      datesDueBetween(item,dueStart,dueEnd,"nextDueDate").forEach(function(date){
        upcomingRecurring.push({item:item,date:date,amount:Number(item.amount||0),overdue:false});
      });
    }
  });
  const futureRecurring=upcomingRecurring.reduce(function(sum,x){return sum+x.amount;},0);

  const activeGoals=S().data.savingsGoals.filter(function(x){return x.active!==false;});
  const savingsTarget=activeGoals.reduce(function(sum,x){return sum+monthlyPlanForGoal(x);},0);
  const savingsActual=actualSavingsForMonth(key);
  const savingsRemaining=Math.max(0,savingsTarget-savingsActual);
  const reservedSavings=Math.max(savingsTarget,savingsActual);

  const disposableIncome=Math.max(0,budgetIncome-recurringMonthly-reservedSavings);
  const categoryTargets={};
  S().data.budgetCategories.filter(function(x){return x.active!==false;}).forEach(function(record){
    categoryTargets[record.category]=budgetLimit(record,disposableIncome);
  });

  const byCategory=categorySpending(key);
  const spendingClasses={};
  expenseRows.forEach(function(row){
    const cls=row.spendingClass || (row.recurringExpenseId ? "Fixed" : "Flexible");
    spendingClasses[cls]=(spendingClasses[cls]||0)+Number(row.amount||0);
  });
  const day=elapsedDays();
  const monthDays=daysInCurrentMonth();
  const paceProjection=actualExpenses/day*monthDays;
  const committedProjection=actualExpenses+futureRecurring;
  const projectedExpenses=Math.max(actualExpenses,paceProjection,committedProjection);
  const projectedSurplus=budgetIncome-projectedExpenses-reservedSavings;
  const remainingPool=budgetIncome-actualExpenses-futureRecurring-reservedSavings;
  const safeDaily=Math.max(0,remainingPool/remainingDays());
  const trackedBalance=currentTrackedBalance();

  const categoryRows=Object.keys(Object.assign({},byCategory,categoryTargets)).map(function(category){
    const spent=Number(byCategory[category]||0);
    const limit=Number(categoryTargets[category]||0);
    const projected=spent/day*monthDays;
    const remaining=limit?limit-spent:0;
    const pace=limit?limit*day/monthDays:0;
    return {category:category,spent:spent,limit:limit,projected:projected,remaining:remaining,pace:pace};
  }).sort(function(a,b){
    if(a.limit&&b.limit)return (b.projected-b.limit)-(a.projected-a.limit);
    return b.spent-a.spent;
  });

  return {
    key:key,incomeRows:incomeRows,expenseRows:expenseRows,
    actualIncome:actualIncome,actualExpenses:actualExpenses,expectedIncome:expectedIncome,budgetIncome:budgetIncome,unplannedIncome:unplannedIncome,
    recurringMonthly:recurringMonthly,upcomingRecurring:upcomingRecurring,futureRecurring:futureRecurring,
    savingsTarget:savingsTarget,savingsActual:savingsActual,savingsRemaining:savingsRemaining,reservedSavings:reservedSavings,
    disposableIncome:disposableIncome,byCategory:byCategory,spendingClasses:spendingClasses,categoryTargets:categoryTargets,categoryRows:categoryRows,
    paceProjection:paceProjection,projectedExpenses:projectedExpenses,projectedSurplus:projectedSurplus,
    remainingPool:remainingPool,safeDaily:safeDaily,trackedBalance:trackedBalance,day:day,monthDays:monthDays,remainingDays:remainingDays()
  };
}

function cutbackOpportunities(snap){
  const opportunities=[];
  snap.categoryRows.forEach(function(row){
    if(row.limit>0 && row.projected>row.limit+.5){
      const over=row.projected-row.limit;
      const weekly=snap.remainingDays>0?over/Math.max(1,snap.remainingDays/7):over;
      opportunities.push({
        severity:over/Math.max(1,row.limit),
        title:row.category+" is projected "+money(over)+" over target",
        text:"Reduce about "+money(weekly)+"/week for the rest of the month to move back toward your "+money(row.limit)+" target.",
        impact:over
      });
    }else if(!row.limit && row.spent>0){
      const avg=pastCategoryAverage(row.category,3);
      if(avg>0 && row.projected>avg*1.18){
        const over=row.projected-avg;
        opportunities.push({
          severity:over/Math.max(1,avg),
          title:row.category+" is running above your recent average",
          text:"Projected "+money(row.projected)+" vs about "+money(avg)+" across the previous 3 months.",
          impact:over
        });
      }
    }
  });

  const small=snap.expenseRows.filter(function(t){return Number(t.amount||0)>0&&Number(t.amount||0)<10;});
  const smallTotal=sumAmounts(small);
  if(small.length>=4 && smallTotal>=20){
    opportunities.push({
      severity:.2,
      title:small.length+" purchases under $10 total "+money(smallTotal),
      text:"Small purchases are not automatically bad, but they are an easy place to inspect for low-value spending.",
      impact:smallTotal*.2
    });
  }

  return opportunities.sort(function(a,b){return b.severity-a.severity;}).slice(0,6);
}

function improvementSuggestions(snap){
  const suggestions=[];
  const cuts=cutbackOpportunities(snap);
  if(snap.budgetIncome<=0){
    suggestions.push({title:"Add expected income",text:"NEXUS cannot calculate a useful safe-to-spend number until income is recorded or an income source is configured.",type:"amber"});
  }
  if(snap.projectedSurplus<0){
    suggestions.push({
      title:"Close a projected "+money(Math.abs(snap.projectedSurplus))+" shortfall",
      text:"Reduce flexible spending, increase income, or lower a planned allocation before month end.",
      type:"red"
    });
  }else if(snap.projectedSurplus>0 && snap.budgetIncome>0){
    suggestions.push({
      title:"Projected month-end surplus: "+money(snap.projectedSurplus),
      text:snap.savingsTarget>0?"You are currently on pace to finish above your planned savings allocation.":"Consider assigning part of this surplus to a savings goal.",
      type:"green"
    });
  }
  if(cuts.length){
    suggestions.push({title:"Best cutback: "+cuts[0].title,text:cuts[0].text,type:"amber"});
  }
  if(!S().data.budgetCategories.length){
    suggestions.push({title:"Set category targets",text:"A proper category budget lets NEXUS distinguish normal spending from categories that are actually over plan.",type:""});
  }
  if(!S().data.savingsGoals.length){
    suggestions.push({title:"Give surplus money a job",text:"Add a savings goal so NEXUS reserves that amount before calculating discretionary spending.",type:""});
  }
  if(snap.recurringMonthly>0 && snap.budgetIncome>0 && snap.recurringMonthly/snap.budgetIncome>.35){
    suggestions.push({
      title:"Recurring obligations use "+((snap.recurringMonthly/snap.budgetIncome)*100).toFixed(0)+"% of expected income",
      text:"Review recurring charges for anything you no longer value or use.",
      type:"amber"
    });
  }
  return suggestions.slice(0,6);
}

function yesterdayISO(){
  const d=new Date(); d.setDate(d.getDate()-1); return isoDate(d);
}
function needsAttentionCount(){
  return S().data.receipts.filter(function(r){return r.status==="needs-review";}).length +
    S().data.finderReports.filter(function(r){return r.status==="new"||r.status==="contacted";}).length +
    S().data.assets.filter(function(a){return a.lostMode;}).length;
}

function dailyReviewData(snap){
  const yesterdaySpend=S().data.transactions.filter(function(t){
    return (t.type||"expense")==="expense" && t.date===yesterdayISO();
  }).reduce(function(sum,t){return sum+Number(t.amount||0);},0);
  const cuts=cutbackOpportunities(snap);
  const nextBill=snap.upcomingRecurring.slice().sort(function(a,b){return a.date.localeCompare(b.date);})[0];
  return {
    yesterdaySpend:yesterdaySpend,
    topCut:cuts[0]||null,
    nextBill:nextBill,
    attention:needsAttentionCount()
  };
}

function progressPct(value,max){
  if(!max)return 0;
  return Math.max(0,Math.min(100,value/max*100));
}
function budgetProgress(label,spent,limit,projected){
  const pct=progressPct(spent,limit);
  const projectedOver=limit>0&&projected>limit+.01;
  return "<div class='budget-progress-row'><div class='budget-progress-top'><div><strong>"+esc(label)+"</strong><span>"+money(spent)+" spent"+(limit?" of "+money(limit):"")+"</span></div>"+
    (limit?badge(projectedOver?"Projected over":"On plan",projectedOver?"red":"green"):badge("No target",""))+"</div>"+
    "<div class='budget-track'><span class='"+(pct>100?"over":"")+"' style='width:"+Math.min(100,pct).toFixed(1)+"%'></span></div>"+
    (limit?"<div class='budget-progress-foot'><span>"+(limit-spent>=0?money(limit-spent)+" remaining":money(Math.abs(limit-spent))+" over")+"</span><span>Projected "+money(projected)+"</span></div>":"")+
  "</div>";
}

function summaryCards(snap){
  const surplusType=snap.projectedSurplus<0?"red":snap.projectedSurplus>0?"green":"";
  const balanceValue=snap.trackedBalance==null?"Not set":money(snap.trackedBalance);
  const balanceFoot=snap.trackedBalance==null?"Set your current balance so NEXUS can track money on hand":"Updated from transactions recorded after your balance baseline";
  return "<div class='budget-summary-grid'>"+
    "<section class='card stat-card budget-balance-card'><div class='card-title-row'><span class='stat-label'>Current balance</span><span class='stat-icon'>¤</span></div><div><div class='stat-value'>"+esc(balanceValue)+"</div><div class='stat-foot'>"+esc(balanceFoot)+"</div></div></section>"+
    "<section class='card stat-card'><div class='card-title-row'><span class='stat-label'>Income this month</span><span class='stat-icon'>↥</span></div><div><div class='stat-value'>"+money(snap.actualIncome)+"</div><div class='stat-foot'>"+(snap.expectedIncome?money(snap.expectedIncome)+" expected monthly":"No income plan yet")+"</div></div></section>"+
    "<section class='card stat-card'><div class='card-title-row'><span class='stat-label'>Expenses this month</span><span class='stat-icon'>↧</span></div><div><div class='stat-value'>"+money(snap.actualExpenses)+"</div><div class='stat-foot'>"+money(snap.projectedExpenses)+" projected</div></div></section>"+
    "<section class='card stat-card'><div class='card-title-row'><span class='stat-label'>Projected surplus</span><span class='stat-icon'>◒</span></div><div><div class='stat-value "+surplusType+"'>"+money(snap.projectedSurplus)+"</div><div class='stat-foot'>After planned savings</div></div></section>"+
    "<section class='card stat-card budget-safe-card'><div class='card-title-row'><span class='stat-label'>Safe to spend</span><span class='stat-icon'>◎</span></div><div><div class='stat-value'>"+money(snap.safeDaily)+"/day</div><div class='stat-foot'>"+money(Math.max(0,snap.remainingPool))+" flexible money remaining</div></div></section>"+
  "</div>";
}

function dailyReviewMarkup(snap){
  const review=dailyReviewData(snap);
  let recommendation="Keep discretionary spending at or below "+money(snap.safeDaily)+" today.";
  if(snap.projectedSurplus<0) recommendation="A cut of about "+money(Math.abs(snap.projectedSurplus)/Math.max(1,snap.remainingDays))+" per remaining day would close the current projected shortfall.";
  else if(review.topCut) recommendation=review.topCut.text;

  return "<section class='card budget-daily-review'><div class='card-title-row'><div><div class='eyebrow'>DAILY REVIEW</div><h2>"+new Date().toLocaleDateString([], {weekday:"long",month:"long",day:"numeric"})+"</h2><div class='microcopy'>A quick read of income, expenses, commitments, savings, and attention items.</div></div><button class='btn btn-small btn-secondary' data-budget-action='daily-review'>Open Review</button></div>"+
    "<div class='budget-review-grid'>"+
      "<div><span>Yesterday</span><strong>"+money(review.yesterdaySpend)+" spent</strong></div>"+
      "<div><span>Current balance</span><strong>"+(snap.trackedBalance==null?"Not set":money(snap.trackedBalance))+"</strong></div>"+
      "<div><span>Month cash flow</span><strong>"+money(snap.actualIncome-snap.actualExpenses)+"</strong></div>"+
      "<div><span>Safe today</span><strong>"+money(snap.safeDaily)+"</strong></div>"+
      "<div><span>Needs attention</span><strong>"+review.attention+"</strong></div>"+
    "</div>"+
    "<div class='budget-recommendation'><span>Recommended today</span><strong>"+esc(recommendation)+"</strong></div>"+
  "</section>";
}

function cashFlowPlanMarkup(snap){
  return "<section class='card'><div class='card-title-row'><div><h2>Cash Flow Plan</h2><div class='microcopy'>Where this month's expected money is already committed</div></div></div>"+
    "<div class='budget-flow-list'>"+
      "<div><span>Budgeted income</span><strong>"+money(snap.budgetIncome)+"</strong></div>"+
      "<div><span>Recurring obligations</span><strong>- "+money(snap.recurringMonthly)+"</strong></div>"+
      "<div><span>Planned savings</span><strong>- "+money(snap.reservedSavings)+"</strong></div>"+
      "<div class='budget-flow-emphasis'><span>Flexible monthly pool</span><strong>"+money(Math.max(0,snap.disposableIncome))+"</strong></div>"+
      "<div><span>Actually spent</span><strong>- "+money(snap.actualExpenses)+"</strong></div>"+
      "<div class='budget-flow-emphasis'><span>Remaining after upcoming commitments</span><strong>"+money(snap.remainingPool)+"</strong></div>"+
    "</div></section>";
}

function spendingClassMarkup(snap){
  const classes=["Fixed","Flexible","Discretionary","One-time","Refundable"];
  return "<section class='card'><div class='card-title-row'><div><h2>Spending Mix</h2><div class='microcopy'>Manual and automatic expense classifications this month</div></div></div>"+
    "<div class='budget-class-grid'>"+classes.map(function(cls){
      const value=Number(snap.spendingClasses[cls]||0);
      const pct=snap.actualExpenses?value/snap.actualExpenses*100:0;
      return "<div><span>"+esc(cls)+"</span><strong>"+money(value)+"</strong><small>"+pct.toFixed(0)+"% of spending</small></div>";
    }).join("")+"</div></section>";
}

function categoryBudgetMarkup(snap){
  const rows=snap.categoryRows.filter(function(row){return row.limit>0||row.spent>0;});
  return "<section class='card'><div class='card-title-row'><div><h2>Category Budget</h2><div class='microcopy'>Actual spending vs monthly target and current pace</div></div><button class='btn btn-small btn-secondary' data-budget-action='category-form'>＋ Target</button></div>"+
    (rows.length?"<div class='budget-progress-list'>"+rows.map(function(row){return budgetProgress(row.category,row.spent,row.limit,row.projected);}).join("")+"</div>":
      "<div class='empty-state'><strong>No category budget yet</strong><div>Add dollar targets or percentage-of-disposable-income targets.</div></div>")+
  "</section>";
}

function incomeMarkup(snap){
  const sources=S().data.incomeSources.filter(function(x){return x.active!==false;});
  const actual=snap.incomeRows.slice().sort(function(a,b){return String(b.date).localeCompare(String(a.date));});
  return "<section class='card'><div class='card-title-row'><div><h2>Income Tracker</h2><div class='microcopy'>Fixed income plus live hourly pay-period earnings</div></div><div class='row-actions'><button class='btn btn-small btn-secondary' data-budget-action='income-source-form'>＋ Source</button><button class='btn btn-small btn-primary' data-budget-action='income-entry'>＋ Income</button></div></div>"+
    (sources.length?"<div class='budget-subsection'><div class='eyebrow'>EXPECTED SOURCES</div><div class='hourly-income-list'>"+sources.map(function(source){
      if(source.payType==="hourly"){
        const stats=hourlyPeriodStats(source);
        const period=[source.periodStart?N().dateText(source.periodStart):"",source.periodEnd?N().dateText(source.periodEnd):""].filter(Boolean).join(" – ");
        return "<article class='hourly-income-card'><div class='card-title-row'><div><div class='list-title'>"+esc(source.name)+"</div><div class='list-sub'>"+money(source.hourlyRate||0)+"/hour · "+esc(source.cadence||"biweekly")+(source.nextDate?" · paid "+N().dateText(source.nextDate):"")+"</div></div>"+badge("HOURLY","gold")+"</div>"+
          "<div class='hourly-income-metrics'><div><span>Pay period</span><strong>"+esc(period||"Not set")+"</strong></div><div><span>Hours logged</span><strong>"+stats.totalHours.toFixed(2)+"h</strong><small>"+(stats.overtimeHours?stats.overtimeHours.toFixed(2)+"h overtime":"Regular hours")+"</small></div><div><span>Gross earned</span><strong>"+money(stats.gross)+"</strong><small>"+money(stats.hourlyRate)+"/hr</small></div><div><span>Est. take-home</span><strong>"+money(stats.estimatedNet)+"</strong><small>"+stats.takeHomePercent.toFixed(0)+"% of gross</small></div></div>"+
          "<div class='hourly-income-actions'><div class='microcopy'>Budget estimate: "+money(plannedMonthlyAmount(source,"nextDate"))+"/month based on hours logged so far.</div><div class='row-actions'><button class='btn btn-small btn-primary' data-budget-action='log-hours' data-id='"+esc(source.id)+"'>＋ Hours</button><button class='btn btn-small btn-secondary' data-budget-action='work-history' data-id='"+esc(source.id)+"'>Hours</button><button class='btn btn-small btn-secondary' data-budget-action='record-source-payment' data-id='"+esc(source.id)+"'>Paycheck</button><button class='btn btn-small btn-ghost' data-budget-action='income-source-form' data-id='"+esc(source.id)+"'>Edit</button></div></div></article>";
      }
      return "<div class='list-row'><div><div class='list-title'>"+esc(source.name)+"</div><div class='list-sub'>"+money(source.amount)+" · "+esc(source.cadence||"monthly")+(source.nextDate?" · next "+N().dateText(source.nextDate):"")+"</div></div><div class='row-actions'><strong>"+money(plannedMonthlyAmount(source,"nextDate"))+"/mo</strong><button class='btn btn-small btn-primary' data-budget-action='record-source-payment' data-id='"+esc(source.id)+"'>Record</button><button class='btn btn-small btn-ghost' data-budget-action='income-source-form' data-id='"+esc(source.id)+"'>Edit</button></div></div>";
    }).join("")+"</div></div>":"<div class='inline-note'>Add a fixed or hourly income source. Hourly sources become more accurate as you log hours throughout the pay period.</div>")+
    "<div class='divider'></div><div class='budget-subsection'><div class='eyebrow'>ACTUAL THIS MONTH</div>"+
      (actual.length?"<div class='panel-list'>"+actual.slice(0,8).map(function(row){
        return "<div class='list-row'><div><div class='list-title'>"+esc(row.merchant||"Income")+"</div><div class='list-sub'>"+N().dateText(row.date)+" · "+esc(row.category||"Income")+(row.loggedHours?" · "+Number(row.loggedHours).toFixed(2)+"h period":"")+"</div></div><strong class='green'>+"+money(row.amount)+"</strong></div>";
      }).join("")+"</div>":"<div class='empty-state compact'><strong>No income recorded this month</strong><div>Record a paycheck, reimbursement, gift, scholarship, refund, or other income.</div></div>")+
    "</div></section>";
}
function recurringMarkup(snap){
  const rows=S().data.recurringExpenses.filter(function(x){return x.active!==false;}).slice().sort(function(a,b){return String(a.nextDueDate||"9999").localeCompare(String(b.nextDueDate||"9999"));});
  return "<section class='card'><div class='card-title-row'><div><h2>Recurring Obligations</h2><div class='microcopy'>Bills and commitments reserved before discretionary spending</div></div><button class='btn btn-small btn-secondary' data-budget-action='recurring-form'>＋ Obligation</button></div>"+
    (rows.length?"<div class='panel-list'>"+rows.map(function(item){
      const due=item.nextDueDate?parseDate(item.nextDueDate):null;
      const days=due?Math.ceil((due-parseDate(todayISO()))/86400000):null;
      const dueType=days!=null&&days<=3?"red":days!=null&&days<=7?"amber":"";
      return "<div class='list-row'><div><div class='list-title'>"+esc(item.name)+"</div><div class='list-sub'>"+esc(item.category||"Other")+" · "+esc(item.cadence||"monthly")+(item.nextDueDate?" · due "+N().dateText(item.nextDueDate):"")+"</div></div><div class='row-actions'>"+badge(money(item.amount),dueType)+"<button class='btn btn-small btn-primary' data-budget-action='mark-recurring-paid' data-id='"+esc(item.id)+"'>Paid</button><button class='btn btn-small btn-ghost' data-budget-action='recurring-form' data-id='"+esc(item.id)+"'>Edit</button></div></div>";
    }).join("")+"</div>":"<div class='empty-state'><strong>No recurring obligations</strong><div>Add subscriptions, insurance, memberships, domains, phone bills, or other recurring commitments.</div></div>")+
  "</section>";
}

function savingsMarkup(snap){
  const goals=S().data.savingsGoals.filter(function(x){return x.active!==false;});
  return "<section class='card'><div class='card-title-row'><div><h2>Savings Goals</h2><div class='microcopy'>NEXUS calculates what you should save each month to hit the target date</div></div><button class='btn btn-small btn-secondary' data-budget-action='goal-form'>＋ Goal</button></div>"+
    (goals.length?"<div class='budget-goals'>"+goals.map(function(goal){
      const pct=progressPct(Number(goal.currentAmount||0),Number(goal.targetAmount||0));
      const recommended=requiredMonthlyForGoal(goal);
      const planned=monthlyPlanForGoal(goal);
      const mode=goal.savingsPlanMode||"recommended";
      const months=goal.targetDate?monthsUntilGoal(goal.targetDate):0;
      const shortfall=Math.max(0,recommended-planned);
      return "<article class='budget-goal'><div class='card-title-row'><div><strong>"+esc(goal.name)+"</strong><div class='microcopy'>"+money(goal.currentAmount||0)+" of "+money(goal.targetAmount||0)+(goal.targetDate?" · target "+N().dateText(goal.targetDate):"")+"</div></div>"+badge(pct.toFixed(0)+"%","gold")+"</div>"+
        "<div class='budget-track'><span style='width:"+pct.toFixed(1)+"%'></span></div>"+
        "<div class='budget-goal-plan'><div><span>NEXUS recommendation</span><strong>"+(goal.targetDate?money(recommended)+"/month":"Set a target date")+"</strong><small>"+(goal.targetDate?(months+" month"+(months===1?"":"s")+" remaining"):"Needed to calculate the monthly amount")+"</small></div>"+
        "<div><span>Budget is reserving</span><strong>"+money(planned)+"/month</strong><small>"+(mode==="custom"?(shortfall>0?money(shortfall)+"/month below recommendation":"Custom plan"):"Automatically follows recommendation")+"</small></div></div>"+
        "<div class='budget-goal-foot'><span>"+(Number(goal.targetAmount||0)<=Number(goal.currentAmount||0)?"Goal funded":"Keep contributing to stay on pace")+"</span><div class='row-actions'><button class='btn btn-small btn-primary' data-budget-action='goal-contribute' data-id='"+esc(goal.id)+"'>Contribute</button><button class='btn btn-small btn-ghost' data-budget-action='goal-form' data-id='"+esc(goal.id)+"'>Edit</button></div></div></article>";
    }).join("")+"</div>":"<div class='empty-state'><strong>No savings goals</strong><div>Add a target amount and date; NEXUS will calculate the monthly savings needed automatically.</div></div>")+
  "</section>";
}

function cutbackMarkup(snap){
  const cuts=cutbackOpportunities(snap);
  const improvements=improvementSuggestions(snap);
  return "<div class='grid grid-2 section-gap'>"+
    "<section class='card'><div class='card-title-row'><div><h2>Cutback Opportunities</h2><div class='microcopy'>Based on your targets, pace, and recent history</div></div></div>"+
      (cuts.length?"<div class='panel-list'>"+cuts.map(function(item){
        return "<div class='list-row budget-advice-row'><div><div class='list-title'>"+esc(item.title)+"</div><div class='list-sub'>"+esc(item.text)+"</div></div>"+badge("Potential "+money(item.impact),"amber")+"</div>";
      }).join("")+"</div>":"<div class='empty-state'><strong>No major cutback signal</strong><div>NEXUS does not see a strong over-budget pattern yet.</div></div>")+
    "</section>"+
    "<section class='card'><div class='card-title-row'><div><h2>Improvements</h2><div class='microcopy'>Specific changes that improve the current projection</div></div><button class='btn btn-small btn-secondary' data-budget-action='what-if'>What If?</button></div>"+
      "<div class='panel-list'>"+improvements.map(function(item){return "<div class='list-row'><div><div class='list-title'>"+esc(item.title)+"</div><div class='list-sub'>"+esc(item.text)+"</div></div>"+(item.type?badge(item.type==="green"?"GOOD":item.type==="red"?"ACTION":"WATCH",item.type):"")+"</div>";}).join("")+"</div>"+
    "</section></div>";
}

function renderBudget(){
  const root=document.getElementById("budget-root");
  if(!root)return;
  const snap=snapshot();
  root.innerHTML=
    "<div class='view-header'><div><div class='eyebrow'>BUDGET</div><h1>Budget & Cash Flow</h1><p>Income and expenses cross-referenced with your current balance, commitments, savings, category targets, and spending pace.</p></div><div class='actions'><button class='btn btn-secondary' data-budget-action='starting-balance'>¤ Balance</button><button class='btn btn-secondary' data-budget-action='what-if'>What If?</button><button class='btn btn-secondary' data-budget-action='income-source-form'>Income Source</button><button class='btn btn-primary' data-budget-action='income-entry'>＋ Income</button></div></div>"+
    summaryCards(snap)+
    "<div class='section-gap'>"+dailyReviewMarkup(snap)+"</div>"+
    "<div class='grid grid-2 section-gap'>"+cashFlowPlanMarkup(snap)+spendingClassMarkup(snap)+"</div>"+
    "<div class='grid grid-2 section-gap'>"+categoryBudgetMarkup(snap)+incomeMarkup(snap)+"</div>"+
    "<div class='grid grid-2 section-gap'>"+recurringMarkup(snap)+savingsMarkup(snap)+"</div>"+
    cutbackMarkup(snap);
}

function injectDashboardReview(){
  if(document.getElementById("budget-dashboard-review"))return;
  const view=document.getElementById("view");
  const firstGrid=view&&view.querySelector(".grid.grid-4");
  if(!view||!firstGrid)return;
  const wrap=document.createElement("div");
  wrap.id="budget-dashboard-review";
  wrap.className="section-gap";
  wrap.innerHTML=dailyReviewMarkup(snapshot());
  firstGrid.insertAdjacentElement("afterend",wrap);

  const today=todayISO();
  const last=localStorage.getItem("nexus-budget-review-seen");
  if(last!==today){
    localStorage.setItem("nexus-budget-review-seen",today);
    N().toast("Daily Review ready","Your budget review is ready: income, expenses, safe-to-spend, and cutback opportunities.","success");
  }
}

function formValue(form,name){ return form.elements[name]?form.elements[name].value:""; }

function findById(list,id){return (list||[]).find(function(x){return x.id===id;});}

function budgetSettings(){
  return (S().data.budgetSettings || []).find(function(x){return x.id==="main";}) || (S().data.budgetSettings || [])[0] || {};
}

function timestampMillis(value){
  if(!value)return 0;
  if(typeof value.toMillis==="function")return value.toMillis();
  if(typeof value.toDate==="function")return value.toDate().getTime();
  const parsed=Date.parse(value);
  return Number.isFinite(parsed)?parsed:0;
}

function currentTrackedBalance(){
  const settings=budgetSettings();
  if(settings.startingBalance == null || settings.startingBalance === "") return null;
  let balance=Number(settings.startingBalance||0);
  const capturedAt=timestampMillis(settings.balanceCapturedAt);
  const balanceDate=settings.balanceDate||"";

  S().data.transactions.forEach(function(row){
    let include=false;
    const createdAt=timestampMillis(row.createdAt);
    if(capturedAt && createdAt) include=createdAt>capturedAt && (!balanceDate || !row.date || String(row.date)>=String(balanceDate));
    else if(balanceDate && row.date) include=String(row.date)>String(balanceDate);
    if(!include)return;
    const amount=Number(row.amount||0);
    if(row.type==="income") balance+=amount;
    else balance-=amount;
  });
  return balance;
}

function monthsUntilGoal(targetDate){
  if(!targetDate)return 0;
  const today=parseDate(todayISO());
  const target=parseDate(targetDate);
  const diffDays=Math.ceil((target-today)/86400000);
  if(diffDays<=0)return 1;
  return Math.max(1,Math.ceil(diffDays/30.4375));
}

function requiredMonthlyForGoal(goal){
  if(!goal || !goal.targetDate)return 0;
  const remaining=Math.max(0,Number(goal.targetAmount||0)-Number(goal.currentAmount||0));
  if(remaining<=0)return 0;
  return remaining/monthsUntilGoal(goal.targetDate);
}

function monthlyPlanForGoal(goal){
  const mode=goal.savingsPlanMode || "recommended";
  if(mode==="custom") return Math.max(0,Number(goal.monthlyContribution||0));
  return requiredMonthlyForGoal(goal);
}

function openIncomeEntry(prefill){
  prefill=prefill||{};
  const sources=S().data.incomeSources.filter(function(x){return x.active!==false;});
  const body="<form id='budget-income-form' class='form-grid'>"+
    "<div class='field'><label>Date</label><input name='date' type='date' required value='"+esc(prefill.date||todayISO())+"'></div>"+
    "<div class='field'><label>Income source</label><select name='sourceId'><option value=''>Manual / Other</option>"+sources.map(function(source){return option(source.id,source.name,source.id===prefill.sourceId);}).join("")+"</select></div>"+
    "<div class='field full'><label>Source / description</label><input name='merchant' required maxlength='120' value='"+esc(prefill.merchant||"")+"' placeholder='Paycheck, reimbursement, scholarship…'></div>"+
    "<div class='field'><label>Amount</label><input name='amount' type='number' min='0' step='0.01' required value='"+esc(prefill.amount||"")+"'></div>"+
    "<div class='field'><label>Category</label><select name='category'>"+incomeCategoryOptions(prefill.category||"Paycheck")+"</select></div>"+
    "<div class='field full'><label>Note</label><textarea name='note' maxlength='500'>"+esc(prefill.note||"")+"</textarea></div></form>";
  const modal=N().openModal("Record Income",body,{footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='budget-save-income'>Record Income</button>"});
  const form=modal.querySelector("#budget-income-form");
  form.elements.sourceId.addEventListener("change",function(){
    const source=findById(S().data.incomeSources,form.elements.sourceId.value);
    if(!source)return;
    form.elements.merchant.value=source.name||"";
    form.elements.amount.value=incomeSourcePaymentEstimate(source)||"";
    form.elements.category.value=source.category||"Paycheck";
  });
  modal.querySelector("#budget-save-income").addEventListener("click",async function(){
    if(!form.reportValidity())return;
    const sourceId=formValue(form,"sourceId");
    const source=sourceId?findById(S().data.incomeSources,sourceId):null;
    const stats=source&&source.payType==="hourly"?hourlyPeriodStats(source):null;
    const data={
      date:formValue(form,"date"),type:"income",merchant:formValue(form,"merchant"),
      amount:Number(formValue(form,"amount")),category:formValue(form,"category"),note:formValue(form,"note"),
      incomeSourceId:sourceId||null,
      payType:source&&source.payType||"fixed",
      payPeriodStart:stats?source.periodStart||"":null,payPeriodEnd:stats?source.periodEnd||"":null,
      loggedHours:stats?stats.totalHours:null,estimatedGross:stats?stats.gross:null,estimatedTakeHome:stats?stats.estimatedNet:null,
      createdAt:serverTimestamp(),updatedAt:serverTimestamp()
    };
    try{
      const ref=await addDoc(collection(N().db,"transactions"),data);
      if(sourceId){
        if(source&&source.nextDate&&source.cadence!=="one-time"){
          const update={nextDate:advanceRecordedOccurrence(source.nextDate,source.cadence,data.date),updatedAt:serverTimestamp()};
          if(source.payType==="hourly"){
            update.periodStart=shiftPeriodDate(source.periodStart,source.cadence);
            update.periodEnd=shiftPeriodDate(source.periodEnd,source.cadence);
          }
          await updateDoc(doc(N().db,"incomeSources",sourceId),update);
        }else if(source&&source.cadence==="one-time"){
          await updateDoc(doc(N().db,"incomeSources",sourceId),{active:false,updatedAt:serverTimestamp()});
        }
      }
      await N().writeActivity("budget","Income recorded","transaction",ref.id,data.merchant+" · "+money(data.amount));
      N().closeModal();
      await N().refresh(["transactions","incomeSources","activity"]);
      N().toast("Income recorded",money(data.amount)+" added to this month's cash flow.","success");
    }catch(error){N().toast("Could not record income",error.message||"Try again.","error");}
  });
}

function openIncomeSourceForm(id){
  const existing=findById(S().data.incomeSources,id)||{};
  const payType=existing.payType||"fixed";
  const defaultStart=existing.periodStart||todayISO();
  const defaultEnd=existing.periodEnd||periodEndFromStart(defaultStart,existing.cadence||"biweekly");
  const body="<form id='income-source-form' class='form-grid'>"+
    "<div class='field full'><label>Source name</label><input name='name' required maxlength='120' value='"+esc(existing.name||"")+"' placeholder='Work paycheck'></div>"+
    "<div class='field'><label>Pay type</label><select name='payType'><option value='fixed' "+(payType==="fixed"?"selected":"")+">Fixed amount</option><option value='hourly' "+(payType==="hourly"?"selected":"")+">Hourly pay</option></select></div>"+
    "<div class='field'><label>Pay frequency</label><select name='cadence'>"+cadenceOptions(existing.cadence||"biweekly")+"</select></div>"+
    "<div id='income-fixed-fields' class='field full'><label>Amount per payment</label><input name='amount' type='number' min='0' step='0.01' value='"+esc(existing.amount||"")+"'></div>"+
    "<div id='income-hourly-fields' class='field full'><div class='form-grid'>"+
      "<div class='field'><label>Hourly rate</label><input name='hourlyRate' type='number' min='0' step='0.01' value='"+esc(existing.hourlyRate||"")+"'></div>"+
      "<div class='field'><label>Estimated take-home %</label><input name='takeHomePercent' type='number' min='0' max='100' step='0.1' value='"+esc(existing.takeHomePercent==null?"100":existing.takeHomePercent)+"'><div class='field-hint'>Use 100% for gross-pay budgeting, or lower it to roughly account for withholding.</div></div>"+
      "<div class='field'><label>Current pay period starts</label><input name='periodStart' type='date' value='"+esc(defaultStart)+"'></div>"+
      "<div class='field'><label>Current pay period ends</label><input name='periodEnd' type='date' value='"+esc(defaultEnd)+"'></div>"+
      "<div class='field'><label>Overtime multiplier</label><input name='overtimeMultiplier' type='number' min='1' step='0.1' value='"+esc(existing.overtimeMultiplier||"1.5")+"'></div>"+
      "<div class='field'><label>Live estimate</label><div id='income-hourly-preview' class='goal-recommendation-card'></div></div>"+
    "</div></div>"+
    "<div class='field'><label>Next expected payday</label><input name='nextDate' type='date' value='"+esc(existing.nextDate||todayISO())+"'></div>"+
    "<div class='field'><label>Income category</label><select name='category'>"+incomeCategoryOptions(existing.category||"Paycheck")+"</select></div>"+
    "<div class='field full'><label>Note</label><textarea name='note'>"+esc(existing.note||"")+"</textarea></div>"+
    "<label class='check-row full'><input name='active' type='checkbox' "+(existing.active===false?"":"checked")+"> Active income source</label></form>";
  const modal=N().openModal(existing.id?"Edit Income Source":"Add Income Source",body,{wide:true,footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button>"+(existing.id?"<button class='btn btn-danger' id='delete-income-source'>Delete</button>":"")+"<button class='btn btn-primary' id='save-income-source'>Save</button>"});
  const form=modal.querySelector("#income-source-form");

  function updatePayType(){
    const hourly=formValue(form,"payType")==="hourly";
    modal.querySelector("#income-fixed-fields").classList.toggle("hidden",hourly);
    modal.querySelector("#income-hourly-fields").classList.toggle("hidden",!hourly);
    form.elements.amount.required=!hourly;
    form.elements.hourlyRate.required=hourly;
    form.elements.periodStart.required=hourly;
    form.elements.periodEnd.required=hourly;
    if(hourly){
      const temp=Object.assign({},existing,{
        id:existing.id||"preview",hourlyRate:Number(formValue(form,"hourlyRate")||0),
        takeHomePercent:Number(formValue(form,"takeHomePercent")||100),
        overtimeMultiplier:Number(formValue(form,"overtimeMultiplier")||1.5),
        periodStart:formValue(form,"periodStart"),periodEnd:formValue(form,"periodEnd"),payType:"hourly"
      });
      const stats=existing.id?hourlyPeriodStats(temp):{totalHours:0,gross:0,estimatedNet:0};
      modal.querySelector("#income-hourly-preview").innerHTML="<span>Current logged estimate</span><strong>"+money(stats.estimatedNet)+"</strong><small>"+Number(stats.totalHours||0).toFixed(2)+" hours · "+money(stats.gross||0)+" gross</small>";
    }
  }

  form.elements.payType.addEventListener("change",updatePayType);
  ["hourlyRate","takeHomePercent","overtimeMultiplier","periodStart","periodEnd"].forEach(function(name){
    form.elements[name].addEventListener("input",updatePayType);
    form.elements[name].addEventListener("change",updatePayType);
  });
  form.elements.cadence.addEventListener("change",function(){
    if(formValue(form,"payType")==="hourly" && formValue(form,"periodStart")) form.elements.periodEnd.value=periodEndFromStart(formValue(form,"periodStart"),formValue(form,"cadence"));
    updatePayType();
  });
  form.elements.periodStart.addEventListener("change",function(){
    if(formValue(form,"payType")==="hourly") form.elements.periodEnd.value=periodEndFromStart(formValue(form,"periodStart"),formValue(form,"cadence"));
    updatePayType();
  });
  updatePayType();

  modal.querySelector("#save-income-source").addEventListener("click",async function(){
    if(!form.reportValidity())return;
    const type=formValue(form,"payType");
    const data={
      name:formValue(form,"name"),payType:type,cadence:formValue(form,"cadence"),nextDate:formValue(form,"nextDate"),
      category:formValue(form,"category"),note:formValue(form,"note"),active:form.elements.active.checked,updatedAt:serverTimestamp(),
      amount:type==="fixed"?Number(formValue(form,"amount")||0):0,
      hourlyRate:type==="hourly"?Number(formValue(form,"hourlyRate")||0):0,
      takeHomePercent:type==="hourly"?Number(formValue(form,"takeHomePercent")||100):100,
      overtimeMultiplier:type==="hourly"?Number(formValue(form,"overtimeMultiplier")||1.5):1.5,
      periodStart:type==="hourly"?formValue(form,"periodStart"):"",
      periodEnd:type==="hourly"?formValue(form,"periodEnd"):""
    };
    if(existing.id)await updateDoc(doc(N().db,"incomeSources",existing.id),data);
    else{data.createdAt=serverTimestamp();await addDoc(collection(N().db,"incomeSources"),data);}
    N().closeModal();await N().refresh(["incomeSources"]);
    N().toast("Income source saved",type==="hourly"?"Log hours during the pay period and NEXUS will update the income estimate live.":"Budget projections updated.","success");
  });
  const del=modal.querySelector("#delete-income-source");
  if(del)del.addEventListener("click",async function(){if(!confirm("Delete this income source? Actual income transactions and work-hour history will remain."))return;await deleteDoc(doc(N().db,"incomeSources",existing.id));N().closeModal();await N().refresh(["incomeSources"]);});
}

function openHoursForm(id){
  const source=findById(S().data.incomeSources,id);
  if(!source || source.payType!=="hourly")return;
  const body="<div class='hourly-period-summary'><div><span>Pay period</span><strong>"+esc(N().dateText(source.periodStart)+" – "+N().dateText(source.periodEnd))+"</strong></div><div><span>Rate</span><strong>"+money(source.hourlyRate)+"/hr</strong></div></div>"+
    "<form id='work-hours-form' class='form-grid section-gap'>"+
      "<div class='field'><label>Work date</label><input name='date' type='date' required value='"+esc(todayISO())+"' min='"+esc(source.periodStart||"")+"' max='"+esc(source.periodEnd||"")+"'></div>"+
      "<div class='field'><label>Regular hours</label><input name='hours' type='number' min='0' max='24' step='0.01' required placeholder='8'></div>"+
      "<div class='field'><label>Overtime hours</label><input name='overtimeHours' type='number' min='0' max='24' step='0.01' value='0'></div>"+
      "<div class='field'><label>Estimated earnings</label><div id='hours-estimate' class='goal-recommendation-card'></div></div>"+
      "<div class='field full'><label>Note</label><textarea name='note' maxlength='300' placeholder='Optional shift note'></textarea></div>"+
    "</form>";
  const modal=N().openModal("Log Hours · "+source.name,body,{footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='save-work-hours'>Add Hours</button>"});
  const form=modal.querySelector("#work-hours-form");
  function estimate(){
    const regular=Number(formValue(form,"hours")||0),ot=Number(formValue(form,"overtimeHours")||0);
    const gross=regular*Number(source.hourlyRate||0)+ot*Number(source.hourlyRate||0)*Number(source.overtimeMultiplier||1.5);
    const net=gross*(Number(source.takeHomePercent==null?100:source.takeHomePercent)/100);
    modal.querySelector("#hours-estimate").innerHTML="<span>This shift</span><strong>"+money(net)+" est. take-home</strong><small>"+money(gross)+" gross · "+(regular+ot).toFixed(2)+" hours</small>";
  }
  form.elements.hours.addEventListener("input",estimate);
  form.elements.overtimeHours.addEventListener("input",estimate);
  estimate();
  modal.querySelector("#save-work-hours").addEventListener("click",async function(){
    if(!form.reportValidity())return;
    const hours=Number(formValue(form,"hours")||0),overtimeHours=Number(formValue(form,"overtimeHours")||0);
    if(hours+overtimeHours<=0){N().toast("Enter hours","Add at least some regular or overtime hours.","error");return;}
    const gross=hours*Number(source.hourlyRate||0)+overtimeHours*Number(source.hourlyRate||0)*Number(source.overtimeMultiplier||1.5);
    await addDoc(collection(N().db,"workHours"),{
      sourceId:source.id,sourceName:source.name,date:formValue(form,"date"),hours:hours,overtimeHours:overtimeHours,
      hourlyRate:Number(source.hourlyRate||0),overtimeMultiplier:Number(source.overtimeMultiplier||1.5),
      grossEstimated:gross,note:formValue(form,"note"),createdAt:serverTimestamp(),updatedAt:serverTimestamp()
    });
    await N().writeActivity("budget","Work hours logged","incomeSource",source.id,source.name+" · "+(hours+overtimeHours).toFixed(2)+"h · "+money(gross)+" gross");
    N().closeModal();await N().refresh(["workHours","activity"]);
    N().toast("Hours logged",(hours+overtimeHours).toFixed(2)+" hours added to the current pay period.","success");
  });
}

function openWorkHistory(id){
  const source=findById(S().data.incomeSources,id); if(!source)return;
  const logs=(S().data.workHours||[]).filter(function(log){return log.sourceId===id;}).sort(function(a,b){return String(b.date||"").localeCompare(String(a.date||""));});
  const current=hourlyPeriodStats(source);
  const body="<div class='hourly-history-summary'><div><span>Current period hours</span><strong>"+current.totalHours.toFixed(2)+"h</strong></div><div><span>Gross earned</span><strong>"+money(current.gross)+"</strong></div><div><span>Estimated take-home</span><strong>"+money(current.estimatedNet)+"</strong></div></div>"+
    "<div class='divider'></div>"+(logs.length?"<div class='panel-list'>"+logs.slice(0,40).map(function(log){
      return "<div class='list-row'><div><div class='list-title'>"+N().dateText(log.date)+" · "+(Number(log.hours||0)+Number(log.overtimeHours||0)).toFixed(2)+"h</div><div class='list-sub'>"+Number(log.hours||0).toFixed(2)+" regular"+(Number(log.overtimeHours||0)?" · "+Number(log.overtimeHours).toFixed(2)+" overtime":"")+(log.note?" · "+esc(log.note):"")+"</div></div><div class='row-actions'><strong>"+money(log.grossEstimated||0)+" gross</strong><button class='icon-btn' data-budget-action='delete-work-log' data-id='"+esc(log.id)+"' data-source-id='"+esc(id)+"' title='Delete'>×</button></div></div>";
    }).join("")+"</div>":"<div class='empty-state'><strong>No hours logged</strong><div>Log each shift as the pay period goes by.</div></div>");
  N().openModal("Hours · "+source.name,body,{wide:true,footer:"<button class='btn btn-secondary' data-close-modal>Close</button><button class='btn btn-primary' data-budget-action='log-hours' data-id='"+esc(id)+"'>＋ Log Hours</button>"});
}

async function deleteWorkLog(id,sourceId){
  if(!id)return;
  if(!confirm("Delete this hours entry?"))return;
  await deleteDoc(doc(N().db,"workHours",id));
  await N().refresh(["workHours"]);
  N().toast("Hours entry deleted","The pay-period estimate has been recalculated.","success");
  N().closeModal();
  setTimeout(function(){openWorkHistory(sourceId);},0);
}

function openRecurringForm(id){
  const existing=findById(S().data.recurringExpenses,id)||{};
  const body="<form id='recurring-form' class='form-grid'>"+
    "<div class='field full'><label>Obligation</label><input name='name' required value='"+esc(existing.name||"")+"' placeholder='Phone bill, subscription, domain renewal…'></div>"+
    "<div class='field'><label>Amount</label><input name='amount' type='number' min='0' step='0.01' required value='"+esc(existing.amount||"")+"'></div>"+
    "<div class='field'><label>Frequency</label><select name='cadence'>"+cadenceOptions(existing.cadence||"monthly")+"</select></div>"+
    "<div class='field'><label>Next due date</label><input name='nextDueDate' type='date' required value='"+esc(existing.nextDueDate||todayISO())+"'></div>"+
    "<div class='field'><label>Category</label><select name='category'>"+expenseCategoryOptions(existing.category||"Subscriptions")+"</select></div>"+
    "<div class='field full'><label>Merchant / payee</label><input name='merchant' value='"+esc(existing.merchant||existing.name||"")+"'></div>"+
    "<div class='field full'><label>Note</label><textarea name='note'>"+esc(existing.note||"")+"</textarea></div>"+
    "<label class='check-row full'><input name='active' type='checkbox' "+(existing.active===false?"":"checked")+"> Active obligation</label></form>";
  const modal=N().openModal(existing.id?"Edit Recurring Obligation":"Add Recurring Obligation",body,{footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button>"+(existing.id?"<button class='btn btn-danger' id='delete-recurring'>Delete</button>":"")+"<button class='btn btn-primary' id='save-recurring'>Save</button>"});
  const form=modal.querySelector("#recurring-form");
  modal.querySelector("#save-recurring").addEventListener("click",async function(){
    if(!form.reportValidity())return;
    const data={name:formValue(form,"name"),merchant:formValue(form,"merchant"),amount:Number(formValue(form,"amount")),cadence:formValue(form,"cadence"),nextDueDate:formValue(form,"nextDueDate"),category:formValue(form,"category"),note:formValue(form,"note"),active:form.elements.active.checked,updatedAt:serverTimestamp()};
    if(existing.id)await updateDoc(doc(N().db,"recurringExpenses",existing.id),data);
    else{data.createdAt=serverTimestamp();await addDoc(collection(N().db,"recurringExpenses"),data);}
    N().closeModal();await N().refresh(["recurringExpenses"]);N().toast("Obligation saved","Safe-to-spend has been recalculated.","success");
  });
  const del=modal.querySelector("#delete-recurring");
  if(del)del.addEventListener("click",async function(){if(!confirm("Delete this recurring obligation?"))return;await deleteDoc(doc(N().db,"recurringExpenses",existing.id));N().closeModal();await N().refresh(["recurringExpenses"]);});
}

async function markRecurringPaid(id){
  const item=findById(S().data.recurringExpenses,id);
  if(!item)return;
  const date=todayISO();
  try{
    const ref=await addDoc(collection(N().db,"transactions"),{
      date:date,type:"expense",merchant:item.merchant||item.name,amount:Number(item.amount||0),category:item.category||"Subscriptions",
      spendingClass:"Fixed",note:"Recurring obligation · "+(item.note||""),recurringExpenseId:item.id,createdAt:serverTimestamp(),updatedAt:serverTimestamp()
    });
    if(item.cadence==="one-time"){
      await updateDoc(doc(N().db,"recurringExpenses",id),{active:false,lastPaidAt:serverTimestamp(),updatedAt:serverTimestamp()});
    }else{
      await updateDoc(doc(N().db,"recurringExpenses",id),{nextDueDate:advanceRecordedOccurrence(item.nextDueDate,item.cadence,date),lastPaidAt:serverTimestamp(),updatedAt:serverTimestamp()});
    }
    await N().writeActivity("budget","Recurring obligation paid","transaction",ref.id,item.name+" · "+money(item.amount));
    await N().refresh(["transactions","recurringExpenses","activity"]);
    N().toast("Marked paid",item.name+" was recorded as an expense.","success");
  }catch(error){N().toast("Could not record payment",error.message||"Try again.","error");}
}

function openCategoryForm(category){
  const existing=S().data.budgetCategories.find(function(x){return x.category===category;})||{};
  const body="<form id='budget-category-form' class='form-grid'>"+
    "<div class='field'><label>Category</label><select name='category'>"+expenseCategoryOptions(existing.category||category||"Dining")+"</select></div>"+
    "<div class='field'><label>Target style</label><select name='targetType'><option value='amount' "+((existing.targetType||"amount")==="amount"?"selected":"")+">Monthly dollar limit</option><option value='percent' "+(existing.targetType==="percent"?"selected":"")+">Percent of disposable income</option></select></div>"+
    "<div class='field'><label>Target value</label><input name='value' type='number' min='0' step='0.01' required value='"+esc(existing.value||"")+"'></div>"+
    "<label class='check-row'><input name='active' type='checkbox' "+(existing.active===false?"":"checked")+"> Active target</label></form>";
  const modal=N().openModal(existing.id?"Edit Category Budget":"Add Category Budget",body,{footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button>"+(existing.id?"<button class='btn btn-danger' id='delete-budget-category'>Delete</button>":"")+"<button class='btn btn-primary' id='save-budget-category'>Save Target</button>"});
  const form=modal.querySelector("#budget-category-form");
  modal.querySelector("#save-budget-category").addEventListener("click",async function(){
    if(!form.reportValidity())return;
    const chosen=formValue(form,"category");
    const duplicate=S().data.budgetCategories.find(function(x){return x.category===chosen&&x.id!==existing.id;});
    const data={category:chosen,targetType:formValue(form,"targetType"),value:Number(formValue(form,"value")),active:form.elements.active.checked,updatedAt:serverTimestamp()};
    if(existing.id)await updateDoc(doc(N().db,"budgetCategories",existing.id),data);
    else if(duplicate)await updateDoc(doc(N().db,"budgetCategories",duplicate.id),data);
    else{data.createdAt=serverTimestamp();await addDoc(collection(N().db,"budgetCategories"),data);}
    N().closeModal();await N().refresh(["budgetCategories"]);N().toast("Budget target saved",chosen+" will now be evaluated against actual spending.","success");
  });
  const del=modal.querySelector("#delete-budget-category");
  if(del)del.addEventListener("click",async function(){if(!confirm("Delete this category budget?"))return;await deleteDoc(doc(N().db,"budgetCategories",existing.id));N().closeModal();await N().refresh(["budgetCategories"]);});
}

function openGoalForm(id){
  const existing=findById(S().data.savingsGoals,id)||{};
  const defaultMode=existing.savingsPlanMode || "recommended";
  const body="<form id='savings-goal-form' class='form-grid'>"+
    "<div class='field full'><label>Goal</label><input name='name' required value='"+esc(existing.name||"")+"' placeholder='College fund, emergency savings…'></div>"+
    "<div class='field'><label>Target amount</label><input name='targetAmount' type='number' min='0' step='0.01' required value='"+esc(existing.targetAmount||"")+"'></div>"+
    "<div class='field'><label>Already saved</label><input name='currentAmount' type='number' min='0' step='0.01' value='"+esc(existing.currentAmount||"0")+"'></div>"+
    "<div class='field'><label>Target date</label><input name='targetDate' type='date' value='"+esc(existing.targetDate||"")+"'></div>"+
    "<div class='field'><label>Savings plan</label><select name='savingsPlanMode'><option value='recommended' "+(defaultMode==="recommended"?"selected":"")+">Use NEXUS recommendation automatically</option><option value='custom' "+(defaultMode==="custom"?"selected":"")+">Use my own monthly amount</option></select></div>"+
    "<div class='field full'><div id='goal-recommendation' class='goal-recommendation-card'></div></div>"+
    "<div class='field full' id='goal-custom-field'><label>Custom monthly contribution</label><input name='monthlyContribution' type='number' min='0' step='0.01' value='"+esc(existing.monthlyContribution||"")+"'><div class='field-hint'>Only used when Savings plan is set to custom.</div></div>"+
    "<label class='check-row full'><input name='active' type='checkbox' "+(existing.active===false?"":"checked")+"> Active goal</label></form>";
  const modal=N().openModal(existing.id?"Edit Savings Goal":"Add Savings Goal",body,{footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button>"+(existing.id?"<button class='btn btn-danger' id='delete-goal'>Delete</button>":"")+"<button class='btn btn-primary' id='save-goal'>Save Goal</button>"});
  const form=modal.querySelector("#savings-goal-form");

  function recommendation(){
    const temp={
      targetAmount:Number(formValue(form,"targetAmount")||0),
      currentAmount:Number(formValue(form,"currentAmount")||0),
      targetDate:formValue(form,"targetDate")
    };
    const recommended=requiredMonthlyForGoal(temp);
    const months=temp.targetDate?monthsUntilGoal(temp.targetDate):0;
    const remaining=Math.max(0,temp.targetAmount-temp.currentAmount);
    const panel=modal.querySelector("#goal-recommendation");
    if(!temp.targetDate){
      panel.innerHTML="<span>Monthly recommendation</span><strong>Choose a target date</strong><small>NEXUS needs a deadline to calculate how much to save each month.</small>";
    }else if(remaining<=0){
      panel.innerHTML="<span>Monthly recommendation</span><strong>"+money(0)+"/month</strong><small>This goal is already fully funded.</small>";
    }else{
      panel.innerHTML="<span>Monthly recommendation</span><strong>"+money(recommended)+"/month</strong><small>"+money(remaining)+" remaining across about "+months+" month"+(months===1?"":"s")+".</small>";
    }
    const custom=modal.querySelector("#goal-custom-field");
    const customMode=formValue(form,"savingsPlanMode")==="custom";
    custom.classList.toggle("hidden",!customMode);
    form.elements.monthlyContribution.disabled=!customMode;
  }
  ["targetAmount","currentAmount","targetDate","savingsPlanMode"].forEach(function(name){
    form.elements[name].addEventListener("input",recommendation);
    form.elements[name].addEventListener("change",recommendation);
  });
  recommendation();

  modal.querySelector("#save-goal").addEventListener("click",async function(){
    if(!form.reportValidity())return;
    const mode=formValue(form,"savingsPlanMode");
    const temp={targetAmount:Number(formValue(form,"targetAmount")),currentAmount:Number(formValue(form,"currentAmount")),targetDate:formValue(form,"targetDate")};
    const recommended=requiredMonthlyForGoal(temp);
    const data={
      name:formValue(form,"name"),targetAmount:temp.targetAmount,currentAmount:temp.currentAmount,
      monthlyContribution:mode==="custom"?Number(formValue(form,"monthlyContribution")||0):recommended,
      savingsPlanMode:mode,targetDate:temp.targetDate,active:form.elements.active.checked,updatedAt:serverTimestamp()
    };
    if(existing.id)await updateDoc(doc(N().db,"savingsGoals",existing.id),data);
    else{data.createdAt=serverTimestamp();await addDoc(collection(N().db,"savingsGoals"),data);}
    N().closeModal();await N().refresh(["savingsGoals"]);
    N().toast("Savings goal saved",mode==="recommended"?"NEXUS will keep recalculating the monthly amount automatically.":"Your custom monthly savings amount will be used in the budget.","success");
  });
  const del=modal.querySelector("#delete-goal");
  if(del)del.addEventListener("click",async function(){if(!confirm("Delete this savings goal? Contribution history will remain."))return;await deleteDoc(doc(N().db,"savingsGoals",existing.id));N().closeModal();await N().refresh(["savingsGoals"]);});
}

function openStartingBalance(){
  const settings=budgetSettings();
  const current=currentTrackedBalance();
  const body="<div class='inline-note'>Enter the amount of money you have <strong>right now</strong>. This becomes a new balance baseline. NEXUS will adjust it using transactions recorded after you save this snapshot, so old transactions are not counted twice.</div>"+
    "<form id='starting-balance-form' class='form-grid section-gap'>"+
      "<div class='field'><label>Current balance</label><input name='startingBalance' type='number' step='0.01' required value='"+esc(settings.startingBalance==null?"":settings.startingBalance)+"' placeholder='0.00'></div>"+
      "<div class='field'><label>Snapshot</label><input value='"+esc(N().dateText(todayISO()))+"' disabled></div>"+
      "<div class='field full'><label>Note</label><textarea name='balanceNote' maxlength='300' placeholder='Optional — checking + cash, current available balance, etc.'>"+esc(settings.balanceNote||"")+"</textarea></div>"+
    "</form>"+
    (current!=null?"<div class='goal-recommendation-card'><span>Currently tracked by NEXUS</span><strong>"+money(current)+"</strong><small>Saving a new snapshot resets the baseline to the amount above.</small></div>":"");
  const modal=N().openModal(settings.id?"Update Current Balance":"Set Current Balance",body,{footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='save-starting-balance'>Save Balance</button>"});
  const form=modal.querySelector("#starting-balance-form");
  modal.querySelector("#save-starting-balance").addEventListener("click",async function(){
    if(!form.reportValidity())return;
    const amount=Number(formValue(form,"startingBalance"));
    try{
      await setDoc(doc(N().db,"budgetSettings","main"),{
        startingBalance:amount,balanceDate:todayISO(),balanceNote:formValue(form,"balanceNote"),
        balanceCapturedAt:serverTimestamp(),updatedAt:serverTimestamp()
      },{merge:true});
      await N().writeActivity("budget","Balance baseline updated","budgetSettings","main","Current balance set to "+money(amount));
      N().closeModal();
      await N().refresh(["budgetSettings","activity"]);
      N().toast("Current balance saved",money(amount)+" is now the NEXUS money-on-hand baseline.","success");
    }catch(error){N().toast("Could not save balance",error.message||"Try again.","error");}
  });
}

function openContribution(id){
  const goal=findById(S().data.savingsGoals,id); if(!goal)return;
  const body="<form id='goal-contribution-form' class='form-grid'><div class='field'><label>Date</label><input name='date' type='date' required value='"+todayISO()+"'></div><div class='field'><label>Amount</label><input name='amount' type='number' min='0.01' step='0.01' required></div><div class='field full'><label>Note</label><textarea name='note'></textarea></div></form>";
  const modal=N().openModal("Contribute to "+goal.name,body,{footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='save-goal-contribution'>Record Contribution</button>"});
  const form=modal.querySelector("#goal-contribution-form");
  modal.querySelector("#save-goal-contribution").addEventListener("click",async function(){
    if(!form.reportValidity())return;
    const amount=Number(formValue(form,"amount"));
    await addDoc(collection(N().db,"savingsContributions"),{goalId:goal.id,goalName:goal.name,date:formValue(form,"date"),amount:amount,note:formValue(form,"note"),createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
    await updateDoc(doc(N().db,"savingsGoals",goal.id),{currentAmount:Number(goal.currentAmount||0)+amount,updatedAt:serverTimestamp()});
    await N().writeActivity("budget","Savings contribution","savingsGoal",goal.id,goal.name+" · "+money(amount));
    N().closeModal();await N().refresh(["savingsGoals","savingsContributions","activity"]);N().toast("Contribution recorded",money(amount)+" added to "+goal.name+".","success");
  });
}

function openDailyReview(){
  const snap=snapshot(),review=dailyReviewData(snap),cuts=cutbackOpportunities(snap),improvements=improvementSuggestions(snap);
  const body="<div class='budget-review-modal'>"+
    "<div class='grid grid-4'>"+
      "<div class='insight'><div class='insight-label'>Balance</div><strong>"+(snap.trackedBalance==null?"Not set":money(snap.trackedBalance))+"</strong><p>Money on hand baseline</p></div>"+
      "<div class='insight'><div class='insight-label'>Income</div><strong>"+money(snap.actualIncome)+"</strong><p>"+money(snap.expectedIncome)+" expected</p></div>"+
      "<div class='insight'><div class='insight-label'>Expenses</div><strong>"+money(snap.actualExpenses)+"</strong><p>"+money(snap.projectedExpenses)+" projected</p></div>"+
      "<div class='insight'><div class='insight-label'>Safe today</div><strong>"+money(snap.safeDaily)+"</strong><p>"+money(Math.max(0,snap.remainingPool))+" remaining pool</p></div>"+
      "<div class='insight'><div class='insight-label'>Savings</div><strong>"+money(snap.savingsActual)+"</strong><p>"+money(snap.savingsTarget)+" monthly target</p></div>"+
    "</div>"+
    "<div class='divider'></div><h3>Today</h3><div class='panel-list'>"+
      "<div class='list-row'><div><div class='list-title'>Yesterday's spending</div><div class='list-sub'>Recorded expenses from "+N().dateText(yesterdayISO())+"</div></div><strong>"+money(review.yesterdaySpend)+"</strong></div>"+
      "<div class='list-row'><div><div class='list-title'>Projected month end</div><div class='list-sub'>Income minus projected expenses and savings allocation</div></div>"+badge(money(snap.projectedSurplus),snap.projectedSurplus<0?"red":"green")+"</div>"+
      (review.nextBill?"<div class='list-row'><div><div class='list-title'>Next obligation · "+esc(review.nextBill.item.name)+"</div><div class='list-sub'>"+N().dateText(review.nextBill.date)+"</div></div><strong>"+money(review.nextBill.amount)+"</strong></div>":"")+
      "<div class='list-row'><div><div class='list-title'>Needs Attention</div><div class='list-sub'>Receipt reviews, finder reports, and lost assets</div></div><strong>"+review.attention+"</strong></div>"+
    "</div>"+
    "<div class='divider'></div><h3>Cutbacks & improvements</h3><div class='panel-list'>"+
      (cuts.length?cuts.slice(0,3).map(function(x){return "<div class='list-row'><div><div class='list-title'>"+esc(x.title)+"</div><div class='list-sub'>"+esc(x.text)+"</div></div></div>";}).join(""):"<div class='inline-note'>No strong cutback signal today.</div>")+
      improvements.slice(0,3).map(function(x){return "<div class='list-row'><div><div class='list-title'>"+esc(x.title)+"</div><div class='list-sub'>"+esc(x.text)+"</div></div></div>";}).join("")+
    "</div></div>";
  N().openModal("NEXUS Daily Review",body,{wide:true,footer:"<button class='btn btn-secondary' data-close-modal>Close</button><button class='btn btn-primary' data-budget-action='go-budget'>Open Budget</button>"});
}

function parseWhatIfText(text){
  const lower=String(text||"").toLowerCase();
  const result={category:"",weeklyCut:0,incomeBoost:0,recurringCut:0};
  EXPENSE_CATEGORIES.forEach(function(category){if(lower.includes(category.toLowerCase()))result.category=category;});
  let match=lower.match(/(?:cut|reduce|spend less)[^\d$]{0,30}\$?(\d+(?:\.\d+)?)\s*(?:\/|per\s*)?(?:week|weekly)/);
  if(match)result.weeklyCut=Number(match[1]);
  match=lower.match(/(?:income|earn|add)[^\d$]{0,25}\$?(\d+(?:\.\d+)?)\s*(?:\/|per\s*)?(?:month|monthly)/);
  if(match)result.incomeBoost=Number(match[1]);
  match=lower.match(/(?:cancel|remove|drop)[^\d$]{0,25}\$?(\d+(?:\.\d+)?)\s*(?:\/|per\s*)?(?:month|monthly)/);
  if(match)result.recurringCut=Number(match[1]);
  return result;
}

function openWhatIf(){
  const snap=snapshot();
  const body="<div class='inline-note'>Model a change without altering your real budget. You can type something like <strong>cut Dining by 20/week and add 50/month income</strong>, or use the fields below.</div>"+
    "<div class='field section-gap'><label>Describe a scenario</label><div class='budget-whatif-command'><input id='whatif-text' placeholder='cut Dining by 20/week'><button class='btn btn-secondary' id='parse-whatif' type='button'>Apply Text</button></div></div>"+
    "<form id='whatif-form' class='form-grid'>"+
      "<div class='field'><label>Category to reduce</label><select name='category'><option value=''>Any / none</option>"+expenseCategoryOptions("")+"</select></div>"+
      "<div class='field'><label>Cut per week</label><input name='weeklyCut' type='number' min='0' step='0.01' value='0'></div>"+
      "<div class='field'><label>Additional monthly income</label><input name='incomeBoost' type='number' min='0' step='0.01' value='0'></div>"+
      "<div class='field'><label>Recurring cost removed / month</label><input name='recurringCut' type='number' min='0' step='0.01' value='0'></div>"+
    "</form><div id='whatif-results' class='section-gap'></div>";
  const modal=N().openModal("What-If Budget",body,{wide:true,footer:"<button class='btn btn-secondary' data-close-modal>Close</button>"});
  const form=modal.querySelector("#whatif-form");
  function render(){
    const weekly=Number(form.elements.weeklyCut.value||0);
    const income=Number(form.elements.incomeBoost.value||0);
    const recurring=Number(form.elements.recurringCut.value||0);
    const monthlyCut=weekly*52/12;
    const improvement=monthlyCut+income+recurring;
    const newSurplus=snap.projectedSurplus+improvement;
    const remainingImpact=weekly*Math.max(0,snap.remainingDays/7)+income*(snap.remainingDays/snap.monthDays)+recurring*(snap.remainingDays/snap.monthDays);
    const newDaily=Math.max(0,(snap.remainingPool+remainingImpact)/snap.remainingDays);
    const category=form.elements.category.value;
    modal.querySelector("#whatif-results").innerHTML=
      "<div class='grid grid-3'>"+
        "<div class='insight'><div class='insight-label'>Monthly improvement</div><strong>"+money(improvement)+"</strong><p>"+(category?esc(category)+" reduction included":"Scenario total")+"</p></div>"+
        "<div class='insight'><div class='insight-label'>New projected surplus</div><strong>"+money(newSurplus)+"</strong><p>Current: "+money(snap.projectedSurplus)+"</p></div>"+
        "<div class='insight'><div class='insight-label'>New safe-to-spend</div><strong>"+money(newDaily)+"/day</strong><p>Current: "+money(snap.safeDaily)+"/day</p></div>"+
      "</div><div class='inline-note' style='margin-top:12px'>Annualized improvement: <strong>"+money(improvement*12)+"</strong>. This is a planning model, not a prediction.</div>";
  }
  ["category","weeklyCut","incomeBoost","recurringCut"].forEach(function(name){form.elements[name].addEventListener("input",render);form.elements[name].addEventListener("change",render);});
  modal.querySelector("#parse-whatif").addEventListener("click",function(){
    const parsed=parseWhatIfText(modal.querySelector("#whatif-text").value);
    if(parsed.category)form.elements.category.value=parsed.category;
    if(parsed.weeklyCut)form.elements.weeklyCut.value=parsed.weeklyCut;
    if(parsed.incomeBoost)form.elements.incomeBoost.value=parsed.incomeBoost;
    if(parsed.recurringCut)form.elements.recurringCut.value=parsed.recurringCut;
    render();
  });
  render();
}

function handleAction(event){
  const button=event.target.closest("[data-budget-action],[data-quick='add-income'],[data-quick='add-recurring'],[data-quick='add-savings-goal'],[data-quick='add-budget-target'],[data-quick='set-starting-balance']");
  if(!button)return;
  if(button.matches("[data-quick]")){
    const quick=button.dataset.quick;
    if(["add-income","add-recurring","add-savings-goal","add-budget-target","set-starting-balance"].includes(quick)){
      event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
      N().closeModal();
      setTimeout(function(){
        if(quick==="add-income")openIncomeEntry();
        if(quick==="add-recurring")openRecurringForm();
        if(quick==="add-savings-goal")openGoalForm();
        if(quick==="add-budget-target")openCategoryForm();
        if(quick==="set-starting-balance")openStartingBalance();
      },0);
      return;
    }
  }
  const action=button.dataset.budgetAction;
  if(!action)return;
  event.preventDefault();
  const id=button.dataset.id;
  if(action==="starting-balance")openStartingBalance();
  if(action==="income-entry")openIncomeEntry();
  if(action==="income-source-form")openIncomeSourceForm(id);
  if(action==="log-hours")openHoursForm(id);
  if(action==="work-history")openWorkHistory(id);
  if(action==="delete-work-log")deleteWorkLog(id,button.dataset.sourceId);
  if(action==="record-source-payment"){
    const source=findById(S().data.incomeSources,id);
    if(source)openIncomeEntry({sourceId:source.id,merchant:source.name,amount:incomeSourcePaymentEstimate(source),category:source.category||"Paycheck"});
  }
  if(action==="recurring-form")openRecurringForm(id);
  if(action==="mark-recurring-paid")markRecurringPaid(id);
  if(action==="category-form")openCategoryForm(button.dataset.category);
  if(action==="goal-form")openGoalForm(id);
  if(action==="goal-contribute")openContribution(id);
  if(action==="daily-review")openDailyReview();
  if(action==="what-if")openWhatIf();
  if(action==="go-budget"){N().closeModal();N().setActiveView("budget");}
}

function init(){
  if(BUDGET.initialized||!window.NEXUS)return;
  BUDGET.initialized=true;
  document.addEventListener("click",handleAction,true);
  document.addEventListener("nexus:render",function(event){
    const view=event.detail&&event.detail.view||S().view;
    if(view==="budget")renderBudget();
    if(view==="dashboard")injectDashboardReview();
  });
  if(S().user){
    if(S().view==="budget")renderBudget();
    if(S().view==="dashboard")injectDashboardReview();
  }
}

if(window.NEXUS)init();
else document.addEventListener("nexus:ready",init,{once:true});
