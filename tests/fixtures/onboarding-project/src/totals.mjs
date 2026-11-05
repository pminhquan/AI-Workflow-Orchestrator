export function totalCents(items){
 return items.reduce((total,item)=>total+item.priceCents*item.quantity,0);
}
