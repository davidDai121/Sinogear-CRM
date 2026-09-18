#!/usr/bin/env python3
"""Calculate and append a quote record from JSON; no network or customer writes.
compare: {mode, unit_price_usd, price_source, options:[{quantity,freight_usd,freight_source,insurance_usd?:null|number,insurance_basis?:"freight_10_percent",insurance_source?:string}]}
cost: {mode, procurement_cny, procurement_source, ground_cny, ground_source,
       profit_cny, profit_source, cny_per_usd, fx_source, extra:[{amount_cny,source,approved}], fixed_price_usd?:number, fixed_price_source?:string}
All inputs are per vehicle in cost mode. Comparison freight/insurance are totals per option.
freight_usd includes uncovered approved surcharges/DG converted to USD, excluding costs already in FOB.
"""
import argparse, json, uuid
from pathlib import Path
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, timezone
D=Decimal

def number(v):
    if isinstance(v, bool): raise ValueError('布尔值不是金额')
    n=D(str(v))
    if not n.is_finite() or n<0: raise ValueError('金额必须有限且非负')
    return n

def source(data,key):
    if not isinstance(data.get(key),str) or not data[key].strip(): raise ValueError('缺少来源: '+key)

def money(v): return str(v.quantize(D('0.01'),rounding=ROUND_HALF_UP))

def calculate(data):
    if data['mode']=='compare':
        source(data,'price_source');unit=number(data['unit_price_usd']);plans=[]
        for item in data['options']:
            q=item['quantity']
            if isinstance(q,bool) or not isinstance(q,int) or q<1: raise ValueError('数量必须为正整数')
            source(item,'freight_source');freight=number(item['freight_usd'])
            # Per-option insurance avoids treating one vehicle's insurance as two vehicles'.
            insurance=item.get('insurance_usd')
            if 'insurance_basis' in item:
                if item['insurance_basis']!='freight_10_percent': raise ValueError('不支持的保险预算口径')
                if insurance is not None: raise ValueError('不能同时指定固定保险费和总运费10%保险预算')
                source(item,'insurance_source')
                insurance=freight*D('0.1')
            if insurance is not None: source(item,'insurance_source')
            total=unit*q+freight+(number(insurance) if insurance is not None else D(0))
            plans.append({'quantity':q,'total_usd':money(total),'per_vehicle_usd':money(total/q),
                'insurance':'unknown_excluded' if insurance is None else money(number(insurance)),
                'scope':'vehicle_and_freight_estimate' if insurance is None else 'vehicle_freight_insurance_estimate'})
        if not plans or len({p['quantity'] for p in plans})!=len(plans): raise ValueError('方案为空或数量重复')
        one=next((p for p in plans if p['quantity']==1),None)
        if one:
            for p in plans:
                if p['quantity']>1 and p['scope']==one['scope']:
                    q=p['quantity'];saving=D(one['total_usd'])*q-D(p['total_usd'])
                    p.update(savings_total_usd=money(saving),savings_per_vehicle_usd=money(saving/q),additional_budget_usd=money(D(p['total_usd'])-D(one['total_usd'])))
        return {'plans':plans,'local_taxes_clearance':'excluded_unknown','status':'draft'}
    if data['mode']=='cost':
        for key in ['procurement_source','ground_source','profit_source','fx_source']:source(data,key)
        rate=number(data['cny_per_usd'])
        if rate==0:raise ValueError('汇率不能为零')
        cost=number(data['procurement_cny'])+number(data['ground_cny']);excluded=[];codes={'procurement','ground'}
        for item in data.get('extra',[]):
            if item.get('approved') is not True or not item.get('source'):
                excluded.append(item);continue
            code=item.get('code')
            if not isinstance(code,str) or not code or code in codes:raise ValueError('附加费用项目缺失或重复')
            codes.add(code);cost+=number(item['amount_cny'])
        profit=number(data['profit_cny']);fixed=data.get('fixed_price_usd')
        if fixed is not None:source(data,'fixed_price_source')
        selling=number(fixed) if fixed is not None else (cost+profit)/rate
        # Margin reflects the rounded outward price, not hidden infinite precision.
        rounded=D(money(selling));actual=rounded*rate-cost
        return {'cost_cny':money(cost),'recommended_usd':money(selling),'target_profit_cny':money(profit),
            'profit_at_rounded_price_cny':money(actual),'fixed_price':fixed is not None,'excluded_unapproved':excluded,
            'other_unknown_costs':'not assumed zero; excluded from this confirmed-cost subtotal','status':'draft'}
    raise ValueError('mode只能是compare或cost')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('input');p.add_argument('--out',required=True,help='历史记录目录，追加保存输入与输出，不覆盖')
    a=p.parse_args();data=json.loads(Path(a.input).read_text());result=calculate(data)
    record={'id':str(uuid.uuid4()),'created_at':datetime.now(timezone.utc).isoformat(),'input':data,'result':result}
    folder=Path(a.out);folder.mkdir(parents=True,exist_ok=True);path=folder/(record['id']+'.json')
    with path.open('x') as f:json.dump(record,f,ensure_ascii=False,indent=2)
    print(json.dumps({'path':str(path.resolve()),**result},ensure_ascii=False,indent=2))
