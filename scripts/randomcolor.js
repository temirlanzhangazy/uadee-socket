const randomColor = {};

// [0, 1, 2, 3], 2 => [2, 3, 1, 0]
function tail(arr, ind){
    let mhs, lhs;
    if(arr.length / 2 > ind){
        mhs = arr.length - 1 - ind;
        lhs = ind;
    }else{
        mhs = ind;
        lhs = arr.length - 1 - ind;
    }
    let nd = [arr[ind]];
    for(let i = 0; i < lhs; i++){
        nd.push(arr[ind+i+1]);
        nd.push(arr[ind-i-1]);
    }
    for(let i = 0; i < mhs - lhs; i++){
        nd.push(arr[i]);
    }
    return nd;
}

// yield optimization
// 6=>6 6=>3
// 5=>5 5=>3
// 4=>4 4=>2
// 3=>3 3=>2
// 2=>2 2=>1
// 1=>1 1=>1
// 21   12
function dense(len, den){
    let st = Math.ceil(len / den);
    let nd = [];
    for(let i = 0; i < st; i++){
        for(let j = 0; j < den; j++){
            nd.push(st - i);
        }
    }
    if(len % 2 !== 0){
        nd.shift();
    }
    return nd;
}

// shift the weight to certain part of array by index
// de controls the rate of differing
function shift_weight(arr, ind, de){
    let ta = tail(arr, ind);
    let nd = [];
    let den = dense(arr.length, de)
    for(let i = 0; i < ta.length; i++){
        for(let j = 0; j < den[i]; j++){
            nd.push(ta[i]);
        }
    }
    return nd;
}

randomColor.parseDarkHex = (den) => {
    let hexcode = '0123456789abcdef';
    let ocean = shift_weight(Array.from({length: 16}, (x, i) => hexcode[i]), 0, den);
    return '#' + Array.from({length: 6}).map(ud=>ocean[Math.floor(Math.random() * ocean.length)]).join('');
}

randomColor.parseLightHex = (den) => {
    let hexcode = '0123456789abcdef';
    let ocean = shift_weight(Array.from({length: 16}, (x, i) => hexcode[i]), 16, den);
    return '#' + Array.from({length: 6}).map(ud=>ocean[Math.floor(Math.random() * ocean.length)]).join('');
}

// 2~8, the smaller the more accurate, the larger the faster
// console.log(parseDarkHex(4));

module.exports = randomColor;