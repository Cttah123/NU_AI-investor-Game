// main.js
const form = document.getElementById("clientform");

form.addEventListener("submit", async function (event) {
  event.preventDefault();
  const UserName = document.getElementById("username").value;
 

  const res = await fetch('http://localhost:3000/ask', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    
    //body: JSON.stringify({ prompt: `The first name of the AML suspicious client is ${firstname} and their last name is ${lastname}. They live in ${address}` })
  });

  const data = await res.json();
  console.log("LLM response:", data.response);
});
