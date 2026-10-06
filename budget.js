import {
  collection, addDoc, updateDoc, deleteDoc, doc, serverTimestamp
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

function plannedMonthlyAmount(item,dateField){
  if(!item || item.active===false) return 0;
  if(item.cadence==="one-time"){
    const date=item[dateField];
    return date && monthKey(date)===currentMonthKey() ? Number(item.amount||0) : 0;
  }
  return monthlyEquivalent(item.amount,item.cadence);
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

  const activeIncomeSources=S().data.incomeSources.filter(function(x){return x.active!==false;});
  const expectedIncome=activeIncomeSources.reduce(function(sum,x){return sum+plannedMonthlyAmount(x,"nextDate");},0);
  const budgetIncome=expectedIncome>0?Math.max(actualIncome,expectedIncome):actualIncome;

  const activeRecurring=S().data.recurringExpenses.filter(function(x){return x.active!==false;});
  const recurringMonthly=activeRecurring.reduce(function(sum,x){return sum+plannedMonthlyAmount(x,"nextDueDate");},0);
  const dueStart=parseDate(todayISO());
  const dueEnd=monthEnd();
  const upcomingRecurring=[];
  activeRecurring.forEach(function(item){
    datesDueBetween(item,dueStart,dueEnd,"nextDueDate").forEach(function(date){
      upcomingRecurring.push({item:item,date:date,amount:Number(item.amount||0)});
    });
  });
  const futureRecurring=upcomingRecurring.reduce(function(sum,x){return sum+x.amount;},0);

  const activeGoals=S().data.savingsGoals.filter(function(x){return x.active!==false;});
  const savingsTarget=activeGoals.reduce(function(sum,x){return sum+Number(x.monthlyContribution||0);},0);
  const savingsActual=actualSavingsForMonth(key);
  const savingsRemaining=Math.max(0,savingsTarget-savingsActual);
  const reservedSavings=Math.max(savingsTarget,savingsActual);

  const disposableIncome=Math.max(0,budgetIncome-recurringMonthly-reservedSavings);
  const categoryTargets={};
  S().data.budgetCategories.filter(function(x){return x.active!==false;}).forEach(function(record){
    categoryTargets[record.category]=budgetLimit(record,disposableIncome);
  });

  const byCategory=categorySpending(key);
  const day=elapsedDays();
  const monthDays=daysInCurrentMonth();
  const paceProjection=actualExpenses/day*monthDays;
  const committedProjection=actualExpenses+futureRecurring;
  const projectedExpenses=Math.max(actualExpenses,paceProjection,committedProjection);
  const projectedSurplus=budgetIncome-projectedExpenses-reservedSavings;
  const remainingPool=budgetIncome-actualExpenses-futureRecurring-reservedSavings;
  const safeDaily=Math.max(0,remainingPool/remainingDays());

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
    actualIncome:actualIncome,actualExpenses:actualExpenses,expectedIncome:expectedIncome,budgetIncome:budgetIncome,
    recurringMonthly:recurringMonthly,upcomingRecurring:upcomingRecurring,futureRecurring:futureRecurring,
    savingsTarget:savingsTarget,savingsActual:savingsActual,savingsRemaining:savingsRemaining,reservedSavings:reservedSavings,
    disposableIncome:disposableIncome,byCategory:byCategory,categoryTargets:categoryTargets,categoryRows:categoryRows,
    paceProjection:paceProjection,projectedExpenses:projectedExpenses,projectedSurplus:projectedSurplus,
    remainingPool:remainingPool,safeDaily:safeDaily,day:day,monthDays:monthDays,remainingDays:remainingDays()
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
  return "<div class='grid grid-4'>"+
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
      "<div><span>Month cash flow</span><strong>"+money(snap.actualIncome-snap.actualExpenses)+"</strong></div>"+
      "<div><span>Safe today</span><strong>"+money(snap.safeDaily)+"</strong></div>"+
      "<div><span>Needs attention</span><strong>"+review.attention+"</strong></div>"+
    "</div>"+
    "<div class='budget-recommendation'><span>Recommended today</span><strong>"+esc(recommendation)+"</strong></div>"+
  "</section>";
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
  return "<section class='card'><div class='card-title-row'><div><h2>Income Tracker</h2><div class='microcopy'>Expected income and actual money received</div></div><div class='row-actions'><button class='btn btn-small btn-secondary' data-budget-action='income-source-form'>＋ Source</button><button class='btn btn-small btn-primary' data-budget-action='income-entry'>＋ Income</button></div></div>"+
    (sources.length?"<div class='budget-subsection'><div class='eyebrow'>EXPECTED SOURCES</div><div class='panel-list'>"+sources.map(function(source){
      return "<div class='list-row'><div><div class='list-title'>"+esc(source.name)+"</div><div class='list-sub'>"+money(source.amount)+" · "+esc(source.cadence||"monthly")+(source.nextDate?" · next "+N().dateText(source.nextDate):"")+"</div></div><div class='row-actions'><strong>"+money(plannedMonthlyAmount(source,"nextDate"))+"/mo</strong><button class='btn btn-small btn-primary' data-budget-action='record-source-payment' data-id='"+esc(source.id)+"'>Record</button><button class='btn btn-small btn-ghost' data-budget-action='income-source-form' data-id='"+esc(source.id)+"'>Edit</button></div></div>";
    }).join("")+"</div></div>":"<div class='inline-note'>Add recurring or expected income sources to make projections useful before the money actually arrives.</div>")+
    "<div class='divider'></div><div class='budget-subsection'><div class='eyebrow'>ACTUAL THIS MONTH</div>"+
      (actual.length?"<div class='panel-list'>"+actual.slice(0,8).map(function(row){
        return "<div class='list-row'><div><div class='list-title'>"+esc(row.merchant||"Income")+"</div><div class='list-sub'>"+N().dateText(row.date)+" · "+esc(row.category||"Income")+"</div></div><strong class='green'>+"+money(row.amount)+"</strong></div>";
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
  return "<section class='card'><div class='card-title-row'><div><h2>Savings Goals</h2><div class='microcopy'>Savings are reserved before NEXUS calculates safe discretionary spending</div></div><button class='btn btn-small btn-secondary' data-budget-action='goal-form'>＋ Goal</button></div>"+
    (goals.length?"<div class='budget-goals'>"+goals.map(function(goal){
      const pct=progressPct(Number(goal.currentAmount||0),Number(goal.targetAmount||0));
      return "<article class='budget-goal'><div class='card-title-row'><div><strong>"+esc(goal.name)+"</strong><div class='microcopy'>"+money(goal.currentAmount||0)+" of "+money(goal.targetAmount||0)+(goal.targetDate?" · target "+N().dateText(goal.targetDate):"")+"</div></div>"+badge(pct.toFixed(0)+"%","gold")+"</div><div class='budget-track'><span style='width:"+pct.toFixed(1)+"%'></span></div><div class='budget-goal-foot'><span>"+money(goal.monthlyContribution||0)+"/month planned</span><div class='row-actions'><button class='btn btn-small btn-primary' data-budget-action='goal-contribute' data-id='"+esc(goal.id)+"'>Contribute</button><button class='btn btn-small btn-ghost' data-budget-action='goal-form' data-id='"+esc(goal.id)+"'>Edit</button></div></div></article>";
    }).join("")+"</div>":"<div class='empty-state'><strong>No savings goals</strong><div>Add a goal and NEXUS will reserve its monthly contribution before calculating safe-to-spend.</div></div>")+
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
    "<div class='view-header'><div><div class='eyebrow'>BUDGET</div><h1>Budget & Cash Flow</h1><p>Income and expenses cross-referenced with commitments, savings, category targets, and spending pace.</p></div><div class='actions'><button class='btn btn-secondary' data-budget-action='what-if'>What If?</button><button class='btn btn-secondary' data-budget-action='income-source-form'>Income Source</button><button class='btn btn-primary' data-budget-action='income-entry'>＋ Income</button></div></div>"+
    summaryCards(snap)+
    "<div class='section-gap'>"+dailyReviewMarkup(snap)+"</div>"+
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
    form.elements.amount.value=source.amount||"";
    form.elements.category.value=source.category||"Paycheck";
  });
  modal.querySelector("#budget-save-income").addEventListener("click",async function(){
    if(!form.reportValidity())return;
    const sourceId=formValue(form,"sourceId");
    const data={
      date:formValue(form,"date"),type:"income",merchant:formValue(form,"merchant"),
      amount:Number(formValue(form,"amount")),category:formValue(form,"category"),note:formValue(form,"note"),
      incomeSourceId:sourceId||null,createdAt:serverTimestamp(),updatedAt:serverTimestamp()
    };
    try{
      const ref=await addDoc(collection(N().db,"transactions"),data);
      if(sourceId){
        const source=findById(S().data.incomeSources,sourceId);
        if(source&&source.nextDate&&source.cadence!=="one-time"){
          const next=nextFutureDate(source.nextDate,source.cadence,data.date);
          await updateDoc(doc(N().db,"incomeSources",sourceId),{nextDate:next,updatedAt:serverTimestamp()});
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
  const body="<form id='income-source-form' class='form-grid'>"+
    "<div class='field full'><label>Source name</label><input name='name' required maxlength='120' value='"+esc(existing.name||"")+"' placeholder='Mardel paycheck'></div>"+
    "<div class='field'><label>Amount per payment</label><input name='amount' type='number' min='0' step='0.01' required value='"+esc(existing.amount||"")+"'></div>"+
    "<div class='field'><label>Frequency</label><select name='cadence'>"+cadenceOptions(existing.cadence||"biweekly")+"</select></div>"+
    "<div class='field'><label>Next expected date</label><input name='nextDate' type='date' value='"+esc(existing.nextDate||todayISO())+"'></div>"+
    "<div class='field'><label>Income category</label><select name='category'>"+incomeCategoryOptions(existing.category||"Paycheck")+"</select></div>"+
    "<div class='field full'><label>Note</label><textarea name='note'>"+esc(existing.note||"")+"</textarea></div>"+
    "<label class='check-row full'><input name='active' type='checkbox' "+(existing.active===false?"":"checked")+"> Active income source</label></form>";
  const modal=N().openModal(existing.id?"Edit Income Source":"Add Income Source",body,{footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button>"+(existing.id?"<button class='btn btn-danger' id='delete-income-source'>Delete</button>":"")+"<button class='btn btn-primary' id='save-income-source'>Save</button>"});
  const form=modal.querySelector("#income-source-form");
  modal.querySelector("#save-income-source").addEventListener("click",async function(){
    if(!form.reportValidity())return;
    const data={name:formValue(form,"name"),amount:Number(formValue(form,"amount")),cadence:formValue(form,"cadence"),nextDate:formValue(form,"nextDate"),category:formValue(form,"category"),note:formValue(form,"note"),active:form.elements.active.checked,updatedAt:serverTimestamp()};
    if(existing.id)await updateDoc(doc(N().db,"incomeSources",existing.id),data);
    else{data.createdAt=serverTimestamp();await addDoc(collection(N().db,"incomeSources"),data);}
    N().closeModal();await N().refresh(["incomeSources"]);N().toast("Income source saved","Budget projections updated.","success");
  });
  const del=modal.querySelector("#delete-income-source");
  if(del)del.addEventListener("click",async function(){if(!confirm("Delete this income source? Actual income transactions will remain."))return;await deleteDoc(doc(N().db,"incomeSources",existing.id));N().closeModal();await N().refresh(["incomeSources"]);});
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
      note:"Recurring obligation · "+(item.note||""),recurringExpenseId:item.id,createdAt:serverTimestamp(),updatedAt:serverTimestamp()
    });
    if(item.cadence==="one-time"){
      await updateDoc(doc(N().db,"recurringExpenses",id),{active:false,lastPaidAt:serverTimestamp(),updatedAt:serverTimestamp()});
    }else{
      await updateDoc(doc(N().db,"recurringExpenses",id),{nextDueDate:nextFutureDate(item.nextDueDate,item.cadence,date),lastPaidAt:serverTimestamp(),updatedAt:serverTimestamp()});
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
  const body="<form id='savings-goal-form' class='form-grid'>"+
    "<div class='field full'><label>Goal</label><input name='name' required value='"+esc(existing.name||"")+"' placeholder='College fund, emergency savings…'></div>"+
    "<div class='field'><label>Target amount</label><input name='targetAmount' type='number' min='0' step='0.01' required value='"+esc(existing.targetAmount||"")+"'></div>"+
    "<div class='field'><label>Already saved</label><input name='currentAmount' type='number' min='0' step='0.01' value='"+esc(existing.currentAmount||"0")+"'></div>"+
    "<div class='field'><label>Monthly contribution</label><input name='monthlyContribution' type='number' min='0' step='0.01' value='"+esc(existing.monthlyContribution||"")+"'></div>"+
    "<div class='field'><label>Target date</label><input name='targetDate' type='date' value='"+esc(existing.targetDate||"")+"'></div>"+
    "<label class='check-row full'><input name='active' type='checkbox' "+(existing.active===false?"":"checked")+"> Active goal</label></form>";
  const modal=N().openModal(existing.id?"Edit Savings Goal":"Add Savings Goal",body,{footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button>"+(existing.id?"<button class='btn btn-danger' id='delete-goal'>Delete</button>":"")+"<button class='btn btn-primary' id='save-goal'>Save Goal</button>"});
  const form=modal.querySelector("#savings-goal-form");
  modal.querySelector("#save-goal").addEventListener("click",async function(){
    if(!form.reportValidity())return;
    const data={name:formValue(form,"name"),targetAmount:Number(formValue(form,"targetAmount")),currentAmount:Number(formValue(form,"currentAmount")),monthlyContribution:Number(formValue(form,"monthlyContribution")),targetDate:formValue(form,"targetDate"),active:form.elements.active.checked,updatedAt:serverTimestamp()};
    if(existing.id)await updateDoc(doc(N().db,"savingsGoals",existing.id),data);
    else{data.createdAt=serverTimestamp();await addDoc(collection(N().db,"savingsGoals"),data);}
    N().closeModal();await N().refresh(["savingsGoals"]);N().toast("Savings goal saved","Safe-to-spend now accounts for the planned monthly contribution.","success");
  });
  const del=modal.querySelector("#delete-goal");
  if(del)del.addEventListener("click",async function(){if(!confirm("Delete this savings goal? Contribution history will remain."))return;await deleteDoc(doc(N().db,"savingsGoals",existing.id));N().closeModal();await N().refresh(["savingsGoals"]);});
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
  const button=event.target.closest("[data-budget-action],[data-quick='add-income']");
  if(!button)return;
  if(button.matches("[data-quick='add-income']")){
    event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
    N().closeModal();setTimeout(function(){openIncomeEntry();},0);return;
  }
  const action=button.dataset.budgetAction;
  if(!action)return;
  event.preventDefault();
  const id=button.dataset.id;
  if(action==="income-entry")openIncomeEntry();
  if(action==="income-source-form")openIncomeSourceForm(id);
  if(action==="record-source-payment"){
    const source=findById(S().data.incomeSources,id);
    if(source)openIncomeEntry({sourceId:source.id,merchant:source.name,amount:source.amount,category:source.category||"Paycheck"});
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
