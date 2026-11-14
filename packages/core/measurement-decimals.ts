function decimalParts(value:number) {
  const [coefficient,exponent="0"]=String(value).split("e");
  return {
    units:BigInt(coefficient.replace(".","")),
    places:(coefficient.split(".")[1]?.length??0)-Number(exponent),
  };
}

// Calculate at the supplied decimal precision before converting to JSON numbers.
export function sumMeasurements(left:number,right:number,divisor:1|2=1) {
  const a=decimalParts(left),b=decimalParts(right);
  let places=Math.max(0,a.places,b.places);
  let units=a.units*10n**BigInt(places-a.places)+b.units*10n**BigInt(places-b.places);
  if(divisor===2) {
    units*=5n;
    places++;
  }
  return Number(`${units}e-${places}`);
}
